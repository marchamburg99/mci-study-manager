use std::time::Duration;

const MAX_BYTES: usize = 5 * 1024 * 1024;

fn calendar_url(value: &str) -> Result<reqwest::Url, String> {
    let value = value.trim();
    let (scheme, rest) = value.split_once("://").ok_or("Ungültige Kalender-URL")?;
    let normalized =
        if scheme.eq_ignore_ascii_case("webcal") || scheme.eq_ignore_ascii_case("webcals") {
            format!("https://{rest}")
        } else {
            value.to_string()
        };
    let parsed = reqwest::Url::parse(&normalized).map_err(|_| "Ungültige Kalender-URL")?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Kalender-URL muss HTTPS oder Webcal ohne Zugangsdaten oder Fragment verwenden".into(),
        );
    }
    Ok(parsed)
}

fn append_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if chunk.len() > MAX_BYTES.saturating_sub(body.len()) {
        return Err("Kalender-Feed ist größer als 5 MiB".into());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn validate_calendar(bytes: Vec<u8>) -> Result<String, String> {
    let body =
        String::from_utf8(bytes).map_err(|_| "Kalender-Feed ist kein gültiger UTF-8-Text")?;
    let invalid = || "Antwort ist kein gültiger iCalendar-Feed".to_string();
    if body.contains('\0') {
        return Err(invalid());
    }
    let mut lines = body
        .trim_start_matches('\u{feff}')
        .lines()
        .filter(|line| !line.is_empty());
    if lines.next() != Some("BEGIN:VCALENDAR") {
        return Err(invalid());
    }
    let mut components = vec!["VCALENDAR"];
    let mut version = false;
    for line in lines {
        if components.is_empty() {
            return Err(invalid());
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        if let Some(component) = line.strip_prefix("BEGIN:") {
            if component.is_empty() || component == "VCALENDAR" {
                return Err(invalid());
            }
            components.push(component);
        } else if let Some(component) = line.strip_prefix("END:") {
            if components.pop() != Some(component) {
                return Err(invalid());
            }
        } else if !line.contains(':') {
            return Err(invalid());
        } else if components.len() == 1 && line == "VERSION:2.0" {
            version = true;
        }
    }
    if !components.is_empty() || !version {
        return Err(invalid());
    }
    Ok(body)
}

pub async fn fetch(url: &str) -> Result<String, String> {
    let parsed = calendar_url(url)?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .referer(false)
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Kalender-Client konnte nicht gestartet werden")?;
    // reqwest errors can contain the private feed URL, so never surface or log them.
    let mut response = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| "Kalender-Download fehlgeschlagen")?
        .error_for_status()
        .map_err(|_| "Kalender-Server meldet einen HTTP-Fehler")?;
    if response
        .content_length()
        .is_some_and(|len| len > MAX_BYTES as u64)
    {
        return Err("Kalender-Feed ist größer als 5 MiB".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Kalender-Download wurde unterbrochen")?
    {
        append_chunk(&mut body, &chunk)?;
    }
    validate_calendar(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_secure_calendar_urls_are_accepted() {
        for scheme in ["https", "webcal", "webcals", "WEBCAL"] {
            let url = calendar_url(&format!("{scheme}://example.invalid/private-token")).unwrap();
            assert_eq!(url.scheme(), "https");
        }
        for url in [
            "http://example.invalid/private-token",
            "file:///private-token",
            "https://user:secret@example.invalid/private-token",
            "invalid-private-token",
        ] {
            let error = calendar_url(url).unwrap_err();
            assert!(!error.contains("private-token"));
            assert!(!error.contains("secret"));
        }
    }

    #[test]
    fn chunks_are_bounded_before_extending_the_buffer() {
        let mut body = Vec::new();
        append_chunk(&mut body, &[]).unwrap();
        append_chunk(&mut body, &[1]).unwrap();
        append_chunk(&mut body, &vec![0; MAX_BYTES - 1]).unwrap();
        assert!(append_chunk(&mut body, &[2]).is_err());
        assert_eq!(body.len(), MAX_BYTES);
        let mut empty = Vec::new();
        assert!(append_chunk(&mut empty, &vec![0; MAX_BYTES + 1]).is_err());
        assert!(empty.is_empty());
    }

    #[test]
    fn calendar_requires_utf8_and_balanced_components() {
        let valid = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Hello\r\n world\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert_eq!(validate_calendar(valid.as_bytes().to_vec()).unwrap(), valid);
        for invalid in [
            "",
            "<html>BEGIN:VCALENDAR</html>",
            "BEGIN:VCALENDAR\nVERSION:2.0",
            "BEGIN:VCALENDAR\nEND:VCALENDAR",
            "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nEND:VCALENDAR",
            "BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\ntrailing",
        ] {
            assert!(validate_calendar(invalid.as_bytes().to_vec()).is_err());
        }
        assert!(validate_calendar(vec![0xff]).is_err());
    }
}

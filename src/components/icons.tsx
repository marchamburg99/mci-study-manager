interface IconProps {
  size?: number;
  className?: string;
}

function Base({
  size = 18,
  className,
  children,
  filled = false,
}: IconProps & { children: React.ReactNode; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? 0 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconToday = (p: IconProps) => (
  <Base {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
    <path d="M3.5 10h17" />
    <path d="M8 3v4M16 3v4" />
    <circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" />
  </Base>
);

export const IconGrid = (p: IconProps) => (
  <Base {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
  </Base>
);

export const IconCal = (p: IconProps) => (
  <Base {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
    <path d="M3.5 10h17" />
    <path d="M8 3v4M16 3v4" />
    <path d="M7.5 13.5h2.5M13.5 13.5H17M7.5 16.5h7" />
  </Base>
);

export const IconSearch = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Base>
);

export const IconSync = (p: IconProps) => (
  <Base {...p}>
    <path d="M20 12a8 8 0 0 1-14.2 5" />
    <path d="M4 12a8 8 0 0 1 14.2-5" />
    <path d="M18.5 3.5v4h-4M5.5 20.5v-4h4" />
  </Base>
);

export const IconBack = (p: IconProps) => (
  <Base {...p}>
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </Base>
);

export const IconChevron = (p: IconProps) => (
  <Base {...p}>
    <path d="M9.5 5.5L16 12l-6.5 6.5" />
  </Base>
);

export const IconDoc = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 3.5h8L19 8.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15.5a1 1 0 0 1 1-1z" />
    <path d="M13.5 3.5v5.5H19" />
  </Base>
);

export const IconPencil = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 0 1 3 3L8 18.5 4 20z" />
    <path d="M14.5 6l3 3" />
  </Base>
);

export const IconClock = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Base>
);

export const IconCheck = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12.2l2.4 2.4 4.6-5" />
  </Base>
);

export const IconFolder = (p: IconProps) => (
  <Base {...p}>
    <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7z" />
  </Base>
);

export const IconFlask = (p: IconProps) => (
  <Base {...p}>
    <path d="M9.5 3h5" />
    <path d="M10.5 3v5.2L5.4 17a2.4 2.4 0 0 0 2.1 3.5h9a2.4 2.4 0 0 0 2.1-3.5L13.5 8.2V3" />
    <path d="M7.5 14.5h9" />
  </Base>
);

export const IconSettings = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" />
    <path d="M19.2 13.5a7.5 7.5 0 0 0 0-3l1.6-1.2-1.8-3.1-1.9.8a7.4 7.4 0 0 0-2.6-1.5L14.2 3h-3.6l-.3 2.5a7.4 7.4 0 0 0-2.6 1.5l-1.9-.8L4 9.3l1.6 1.2a7.5 7.5 0 0 0 0 3L4 14.7l1.8 3.1 1.9-.8a7.4 7.4 0 0 0 2.6 1.5l.3 2.5h3.6l.3-2.5a7.4 7.4 0 0 0 2.6-1.5l1.9.8 1.8-3.1-1.6-1.2z" />
  </Base>
);

export const IconOpen = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 4.5h5.5V10" />
    <path d="M19.5 4.5L11 13" />
    <path d="M19.5 14v5.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1H11" />
  </Base>
);

export const IconTrash = (p: IconProps) => (
  <Base {...p}>
    <path d="M4.5 6.5h15" />
    <path d="M9 6V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V6" />
    <path d="M6.5 6.5l1 13a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l1-13" />
    <path d="M10 10.5v6M14 10.5v6" />
  </Base>
);

export const IconCap = (p: IconProps) => (
  <Base {...p}>
    <path d="M2.5 9.5L12 5l9.5 4.5L12 14 2.5 9.5z" />
    <path d="M6.5 11.5V16c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-4.5" />
    <path d="M21.5 9.5V15" />
  </Base>
);

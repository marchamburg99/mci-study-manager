import agentsMd from "../scaffold/vault/AGENTS.md?raw";
import claudeMd from "../scaffold/vault/CLAUDE.md?raw";
import academicWork from "../scaffold/vault/agents/academic-work.md?raw";
import acceptance from "../scaffold/vault/agents/acceptance.md?raw";
import notesLearning from "../scaffold/vault/agents/notes-learning.md?raw";
import referenceBasis from "../scaffold/vault/agents/reference-basis.md?raw";
import research from "../scaffold/vault/agents/research.md?raw";
import vaultContract from "../scaffold/vault/agents/vault-contract.md?raw";
import claudeSettings from "../scaffold/vault/claude-settings.json?raw";
import obsidianTypes from "../scaffold/vault/obsidian-types.json?raw";
import aiUseLog from "../scaffold/vault/templates-agent/ai-use-log.md?raw";
import assignment from "../scaffold/vault/templates-agent/assignment.md?raw";
import learningReview from "../scaffold/vault/templates-agent/learning-review.md?raw";
import researchLog from "../scaffold/vault/templates-agent/research-log.md?raw";
import sourceNote from "../scaffold/vault/templates-agent/source-note.md?raw";
import studyPlan from "../scaffold/vault/templates-agent/study-plan.md?raw";
import aufgabenBase from "../scaffold/vault/views/Aufgaben.base?raw";
import termineBase from "../scaffold/vault/views/Termine.base?raw";

/**
 * Vault files the app creates once and never overwrites: AI agent instructions,
 * agent work templates and Bases views. Paths are relative to the vault root.
 */
export const VAULT_SCAFFOLD: readonly { path: readonly string[]; content: string }[] = [
  { path: ["AGENTS.md"], content: agentsMd },
  { path: ["CLAUDE.md"], content: claudeMd },
  { path: [".agents", "study", "vault-contract.md"], content: vaultContract },
  { path: [".agents", "study", "notes-learning.md"], content: notesLearning },
  { path: [".agents", "study", "research.md"], content: research },
  { path: [".agents", "study", "academic-work.md"], content: academicWork },
  { path: [".agents", "study", "reference-basis.md"], content: referenceBasis },
  { path: [".agents", "study", "acceptance.md"], content: acceptance },
  { path: [".claude", "settings.json"], content: claudeSettings },
  { path: [".obsidian", "types.json"], content: obsidianTypes },
  { path: ["00-system", "templates", "agent", "assignment.md"], content: assignment },
  { path: ["00-system", "templates", "agent", "study-plan.md"], content: studyPlan },
  { path: ["00-system", "templates", "agent", "research-log.md"], content: researchLog },
  { path: ["00-system", "templates", "agent", "source-note.md"], content: sourceNote },
  { path: ["00-system", "templates", "agent", "learning-review.md"], content: learningReview },
  { path: ["00-system", "templates", "agent", "ai-use-log.md"], content: aiUseLog },
  { path: ["00-system", "views", "Termine.base"], content: termineBase },
  { path: ["00-system", "views", "Aufgaben.base"], content: aufgabenBase },
];

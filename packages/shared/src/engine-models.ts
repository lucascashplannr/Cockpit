/**
 * The Claude models the composer can name, newest first within each family.
 *
 * One list for both sides: the core checks which of these the installed
 * `claude` knows, and the window labels whatever it is told. A model the CLI
 * has never heard of fails its launch with `unrecognized_model`, so offering
 * one is offering an error — which is why the list is filtered, not trusted.
 */
export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku'

export interface EngineModel {
  /** The full id `claude --model` takes. */
  id: string
  family: ModelFamily
  label: string
}

/** In the order the menu shows them, and each family newest first. */
export const CLAUDE_MODELS: EngineModel[] = [
  { id: 'claude-fable-5-1', family: 'fable', label: 'Fable 5.1' },
  { id: 'claude-fable-5', family: 'fable', label: 'Fable 5' },
  { id: 'claude-opus-5', family: 'opus', label: 'Opus 5' },
  { id: 'claude-opus-4-8', family: 'opus', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', family: 'opus', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', family: 'opus', label: 'Opus 4.6' },
  { id: 'claude-sonnet-5', family: 'sonnet', label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6', family: 'sonnet', label: 'Sonnet 4.6' },
  { id: 'claude-sonnet-4-5', family: 'sonnet', label: 'Sonnet 4.5' },
  { id: 'claude-haiku-4-5', family: 'haiku', label: 'Haiku 4.5' },
]

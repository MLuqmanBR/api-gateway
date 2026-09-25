import { ArrowRight, AudioLines, Image as ImageIcon, Mic, Type, Video } from 'lucide-react'
import { Tooltip } from '@/components/tooltip'

/**
 * The input modalities the gateway routes on, in display order.
 * `text` is always accepted; the other three are per-model capability flags.
 */
export type ModalityKind = 'text' | 'image' | 'audio' | 'video'

/** Input icons, in fixed order: text, audio, image, video. */
const INPUT_ORDER: ModalityKind[] = ['text', 'audio', 'image', 'video']

/** Per-modality label + colours. Hue values match the reference design; the
 *  tile is the hue at low alpha so light and dark themes both keep contrast
 *  (the reference screenshots are dark-only fixed hexes). */
const MODALITY_STYLE: Record<ModalityKind, { label: string; hint: string; hue: string }> = {
  text: { label: 'Text', hint: 'Text input', hue: '#3B9EE8' },
  audio: { label: 'Audio', hint: 'Audio input', hue: '#9D6BF0' },
  image: { label: 'Image', hint: 'Image input', hue: '#3ECF8E' },
  video: { label: 'Video', hint: 'Video input', hue: '#F05A28' },
}

export interface ModalityRowProps {
  /** Input modalities this model accepts. `text` is implied if omitted. */
  modalities: ModalityKind[]
  /** Output modalities advertised by the model (rendered after the arrow). */
  output?: string[]
  /** `colored` = boxed tiles for the edit modal; `monochrome` = bare icons
   *  for dense table rows. */
  variant?: 'colored' | 'monochrome'
  /** Render input icons as toggle buttons. Output icons are never clickable. */
  interactive?: boolean
  onToggle?: (kind: ModalityKind) => void
  /** Disable all toggles (e.g. while saving). */
  disabled?: boolean
  /**
   * Omit input icons for modalities the model does NOT support, instead of
   * rendering them dimmed.
   *
   * Use in read-only summaries (the fallback table), where a dimmed icon is
   * noise the operator has to filter out on every row. Leave `false` wherever
   * the icon is a control (the edit dialogs): there the disabled icon IS the
   * affordance — it shows what can be switched on.
   */
  hideUnsupported?: boolean
}

/**
 * Render a model's input/output modalities as an icon row.
 *
 * Two variants because the dashboard uses this at two densities: a boxed,
 * colour-coded row in the edit modal where the operator changes capabilities,
 * and a compact monochrome row in the fallback table where it is a read-only
 * summary. Both share the order and the tooltips so the same model reads the
 * same way in both places.
 */
export function ModalityRow({
  modalities,
  output = ['text'],
  variant = 'monochrome',
  interactive = false,
  onToggle,
  disabled = false,
  hideUnsupported = false,
}: ModalityRowProps) {
  const active = new Set(modalities)
  // `text` is always supported; a caller listing only media still gets it.
  active.add('text')

  // Read-only summaries show only what the model accepts (see hideUnsupported).
  // Never applied when `interactive`: there a hidden icon is an unreachable
  // control — toggling a modality off would remove the only way to toggle it
  // back on.
  const inputKinds = hideUnsupported && !interactive ? INPUT_ORDER.filter(k => active.has(k)) : INPUT_ORDER

  const outputSet = new Set(output.map(o => o.toLowerCase()))

  if (variant === 'colored') {
    return (
      <div className="flex flex-wrap items-center gap-[5px]">
        {inputKinds.map(kind => {
          const on = active.has(kind)
          const { label, hue } = MODALITY_STYLE[kind]
          const Icon = kind === 'text' ? Type : kind === 'audio' ? AudioLines : kind === 'image' ? ImageIcon : Video
          const title = on ? `${label} — accepted by this model` : `${label} — not supported by this model`

          const tile = (
            <span
              className="grid size-6 place-items-center rounded-[7px] transition-opacity"
              style={{
                backgroundColor: on ? `${hue}1F` : 'var(--muted)',
                opacity: on ? 1 : 0.45,
              }}
            >
              <Icon className="size-4" style={{ color: on ? hue : undefined }} aria-hidden />
            </span>
          )

          if (!interactive) {
            return (
              <Tooltip key={kind} text={title}>
                {tile}
              </Tooltip>
            )
          }
          return (
            <Tooltip key={kind} text={title}>
              <button
                type="button"
                onClick={() => onToggle?.(kind)}
                disabled={disabled}
                aria-label={`Toggle ${label} input`}
                aria-pressed={on}
                className="rounded-[7px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                {tile}
              </button>
            </Tooltip>
          )
        })}
        <ArrowRight className="mx-2 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {['text', 'image', 'audio', 'video']
          .filter(o => outputSet.has(o))
          .map(o => {
            const kind = o as ModalityKind
            const Icon = kind === 'text' ? Type : kind === 'audio' ? AudioLines : kind === 'image' ? ImageIcon : Video
            return (
              <Tooltip key={`out-${o}`} text={`${MODALITY_STYLE[kind].label} output`}>
                <span className="grid size-6 place-items-center rounded-[7px]" style={{ backgroundColor: `${MODALITY_STYLE[kind].hue}1F` }}>
                  <Icon className="size-4" style={{ color: MODALITY_STYLE[kind].hue }} aria-hidden />
                </span>
              </Tooltip>
            )
          })}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      {inputKinds.map(kind => {
        const on = active.has(kind)
        const { label } = MODALITY_STYLE[kind]
        // The monochrome row uses a microphone for audio (the reference table
        // design) while the colored row uses waveform bars.
        const Icon = kind === 'text' ? Type : kind === 'audio' ? Mic : kind === 'image' ? ImageIcon : Video
        const title = on ? `${label} — accepted by this model` : `${label} — not supported by this model`
        return (
          <Tooltip key={kind} text={title}>
            <Icon
              className={on ? 'size-3.5 text-muted-foreground' : 'size-3.5 text-muted-foreground/25'}
              aria-label={title}
              aria-hidden={false}
            />
          </Tooltip>
        )
      })}
      <ArrowRight className="mx-0.5 size-3.5 text-muted-foreground/60" aria-hidden />
      <Tooltip text="Text output">
        <Type className="size-3.5 text-muted-foreground" aria-hidden />
      </Tooltip>
    </div>
  )
}

export { INPUT_ORDER as MODALITY_INPUT_ORDER }

import { WRAP_TOOL } from '@cockpit/shared'

/**
 * The end of a working turn, said once and short.
 *
 * A long turn ends in a long answer, and what the person needs from it first is
 * three sentences: what is now true, what is not done, and whether anything
 * waits on them. The agent writes that here, as a tool call, so the window can
 * draw it as one box under the answer — with the question it leaves, and a
 * button per likely reply — instead of hoping it is somewhere in the prose.
 *
 * Nothing is stored here: the call is in the journal like any other, and the
 * window reads it from there. Served on the same `cockpit` server as the memory.
 */

const WRAP = 'wrap_up'

export const NAMES = [WRAP]

/** As the engine names them — what `--tools` and `--allowedTools` list. */
export const TOOL_NAMES = [WRAP_TOOL]

const RECAP_MAX = 300
const ASK_MAX = 100
const REPLY_MAX = 24

export const TOOLS = [
  {
    name: WRAP,
    description:
      'Close a working turn with a short recap the person reads first, drawn as a box under your answer. ' +
      'Call it once, when the work of this turn is done, as your last tool call, then write your closing message. ' +
      'Call it in every turn where you changed files, ran commands, or did multi-step work; skip it for a short answer or plain conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        recap: {
          type: 'string',
          description:
            'Two or three short sentences, at most ' + RECAP_MAX + ' characters, to the person: what is now true or changed, ' +
            'then where it stands, including what is not done or not verified (nothing committed, not checked in the app). ' +
            'It must stand on its own: never point at anything else ("see above", "listed below"). Plain prose: no Markdown, no backticks.',
        },
        ask: {
          type: 'string',
          description:
            'Usually omitted. The test: if the person never answered, would what they asked for be done and right? Then there is no question. ' +
            'Ask only when it would not be: two real ways the work could be and the choice is theirs, or an approval for something you must not do alone ' +
            '(deleting data, anything that leaves this machine). Then that one decision as one short question, at most ' + ASK_MAX + ' characters, ' +
            'with no reason, no recommendation, and without listing the options. ' +
            'Anything you could do next is an offer, not a question — fixing something you noticed, the same change on other files, a cleanup, tests: ' +
            '"Clean up the stray typos?", "Translate the other page too?", "Want me to add tests?" are all wrong here. ' +
            'Such a next step, if it matters, is one sentence in your closing message. Never ask to confirm what you did.',
        },
        replies: {
          type: 'array',
          items: { type: 'string' },
          description:
            'With `ask` only: one or two buttons answering it, your recommendation first, each 1–3 words (at most ' + REPLY_MAX + ' characters), ' +
            'written as the person\'s own reply to you ("Yes, fix it", "Not now"). A click sends it to you as their message.',
        },
      },
      required: ['recap'],
    },
  },
]

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

export function call(name: string, args: Record<string, unknown> = {}): Result {
  const text = (t: string, isError = false): Result => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })
  if (name !== WRAP) return text('unknown tool: ' + name, true)
  const recap = typeof args.recap === 'string' ? args.recap.trim() : ''
  if (!recap) return text('Not shown: `recap` is needed.', true)
  const ask = typeof args.ask === 'string' ? args.ask.trim() : ''
  const replies = Array.isArray(args.replies) ? args.replies.filter((r) => typeof r === 'string' && r.trim()) : []
  if (replies.length && !ask) return text('Not shown: `replies` answer `ask`, and there is no `ask`. Call again without them, or with the question.', true)
  // Over the limits is still shown — refusing would cost another step for a
  // box that is only a little long — but the agent hears it, for next time.
  const long = recap.length > RECAP_MAX * 1.3 || ask.length > ASK_MAX * 1.3
  return text(
    'Shown under your answer.' +
      (long ? ' It ran long; keep the recap to ' + RECAP_MAX + ' characters and the question to ' + ASK_MAX + '.' : '') +
      ' Now write your closing message: your full answer to the person, which the recap never replaces.' +
      (ask ? ' Do not repeat the question in it.' : ''),
  )
}

/** What the agent is told at launch, beside the shell rules. */
export const WRAP_RULES = '# Closing a turn\n\n' + [
  'When a turn changed files, ran commands, or did multi-step work, call `' + WRAP_TOOL + '` once when the work is done,',
  'before your closing message, with a two-or-three-sentence recap of what is now true and where it stands, including what is',
  'not done or not verified. Almost always that recap is all. Add `ask` (one question) and `replies` (one or two short answers,',
  'your pick first) only if, without an answer, what the person asked for would not be done and right: two real ways it could be',
  'and the choice is theirs, or an approval for something you must not do alone. Something you could do next — a fix you noticed,',
  'the same change elsewhere, a cleanup — is an offer, never a question: one sentence in your closing message at most.',
  'Skip the tool for a short answer or plain conversation. Your closing message follows it and is your full answer.',
].join(' ')

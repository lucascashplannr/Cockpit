import { WRAP_TOOL, agentCommitRules, commitMessageProblems, gitProposalIn, normalizeCommitRules } from '@cockpit/shared'
import type { Conversation } from '@cockpit/shared'
import { proposalRefusal } from './agentGit.js'
import { loadConfig } from './config.js'

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

/** Settings → Commit messages, as they stand now: they can change while a conversation runs. */
function commitRules() {
  return normalizeCommitRules(loadConfig().commitRules)
}

/**
 * The tool as the engine is shown it. A function and not a constant: the
 * commit rules in `git.message` are read from Settings when the engine asks.
 */
export function tools() {
  return TOOLS.map((t) => {
    const git = t.inputSchema.properties.git
    const message = {
      ...git.properties.message,
      description:
        git.properties.message.description + ' It must follow the commit rules set in Cockpit, exactly: ' +
        agentCommitRules(commitRules()).join('; ') + '. One that breaks them is refused and you write it again.',
    }
    return { ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, git: { ...git, properties: { ...git.properties, message } } } } }
  })
}

const TOOLS = [
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
        git: {
          type: 'object',
          description:
            'Only when the person\'s latest message asked you to stage, commit or push (in any words: "commit this", "push it", "commite", "git add the docs"). ' +
            'Never otherwise: not because the work is finished, not as a suggestion, not because they asked for it in an earlier turn. ' +
            'You cannot run git add, git commit or git push yourself; this puts a button on the card and Cockpit runs it when the person presses it. ' +
            'With `git`, leave out `ask` and `replies`: the button is the question. ' +
            'The card draws the commit itself (message, files, branch, button), so the recap says only what the work changed, ' +
            'in one sentence: never the commit, the button, the branch or whether it is pushed. Never say it is committed.',
          properties: {
            repo: { type: 'string', description: 'The repository\'s folder name. Needed only when this conversation is on more than one.' },
            files: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Paths relative to the repository. With `message`, only these are committed; left out, every change is (untracked included). ' +
                'Without `message`, these are only staged.',
            },
            message: {
              type: 'string',
              description: 'The commit message, when they asked for a commit. No double quotes.',
            },
            push: { type: 'boolean', description: 'They asked for a push: the branch goes to origin after the commit, or on its own without `message`.' },
          },
        },
      },
      required: ['recap'],
    },
  },
]

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

export function call(c: Conversation, name: string, args: Record<string, unknown> = {}): Result {
  const text = (t: string, isError = false): Result => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })
  if (name !== WRAP) return text('unknown tool: ' + name, true)
  const recap = typeof args.recap === 'string' ? args.recap.trim() : ''
  if (!recap) return text('Not shown: `recap` is needed.', true)
  const ask = typeof args.ask === 'string' ? args.ask.trim() : ''
  const replies = Array.isArray(args.replies) ? args.replies.filter((r) => typeof r === 'string' && r.trim()) : []
  if (replies.length && !ask) return text('Not shown: `replies` answer `ask`, and there is no `ask`. Call again without them, or with the question.', true)
  const git = gitProposalIn(args.git)
  if (args.git !== undefined && !git) return text('Not shown: `git` needs a `message`, `files` or `push`. Call again with what the person asked for, or without `git`.', true)
  if (git) {
    if (ask || replies.length) return text('Not shown: with `git` the button is the question. Call again without `ask` and `replies`.', true)
    const refused = proposalRefusal(c, git)
    if (refused) return text('Not shown: ' + refused + '.', true)
    if (git.message) {
      const rules = commitRules()
      const problems = commitMessageProblems(git.message, rules)
      if (problems.length) {
        return text(
          'Not shown: the commit message breaks the commit rules set in Cockpit (' + problems.join('; ') + '). ' +
            'The rules: ' + agentCommitRules(rules).join('; ') + '. Call again with a message that follows them.',
          true,
        )
      }
    }
  }
  // Over the limits is still shown — refusing would cost another step for a
  // box that is only a little long — but the agent hears it, for next time.
  const long = recap.length > RECAP_MAX * 1.3 || ask.length > ASK_MAX * 1.3
  return text(
    'Shown under your answer.' +
      (long ? ' It ran long; keep the recap to ' + RECAP_MAX + ' characters and the question to ' + ASK_MAX + '.' : '') +
      ' Now write your closing message: your full answer to the person, which the recap never replaces.' +
      (ask ? ' Do not repeat the question in it.' : '') +
      (git ? ' Nothing is staged, committed or pushed yet: it runs only when the person presses the button. In your closing message, one short sentence at most that it is ready on the card; never that it is done.' : ''),
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
].join(' ') + '\n\n# Staging, committing, pushing\n\n' + [
  '`git add`, `git commit` and `git push` are refused in your shell. When the person\'s latest message asks you to stage, commit',
  'or push, do the rest of the work, then put exactly that in `' + WRAP_TOOL + '`\'s `git` (the files, a message you write from the',
  'diff following the commit rules in that field\'s description, never with a Co-Authored-By line, push if they said push). The card shows it with a button, and Cockpit runs it as the person\'s own act when they press it.',
  'Only then: never propose git because the work looks finished, never as an offer, never in a turn where they did not ask.',
  'Do not try another way (a script, an alias, `git -C`); say in your answer that it is ready for them to press.',
].join(' ')

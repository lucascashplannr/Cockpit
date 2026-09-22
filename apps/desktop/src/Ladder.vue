<script setup lang="ts">
import { CirclePlay, CircleStop, GitBranch, Server, SquareDot } from '@lucide/vue'

/** Throwaway: the four placements of Servers, drawn in the app's own tokens. */

const repos = [
  { name: 'cashplannr-v2', kind: 'repo', srv: 'up', where: 'herd' },
  { name: 'cashplannr-frontend', kind: 'repo', srv: 'down', where: ':8543' },
  { name: 'cashplannr-projects', kind: 'repo', srv: 'down', where: ':8611' },
]
const branches = [
  { name: 'v2', kind: 'branch', srv: 'up', where: 'cp-583.test' },
  { name: 'frontend', kind: 'branch', srv: 'starting', where: ':8081' },
  { name: 'projects', kind: 'branch', srv: 'none', where: '' },
]
</script>

<template>
  <div class="sheet">
    <!-- ── 0 ─────────────────────────────────────────────────────────── -->
    <section>
      <h2><b>0 · today</b> — a review tab. State lives where you are not looking.</h2>
      <div class="win">
        <div class="rail"><i class="sq on" /><i class="sq" /><i class="sq" /></div>
        <div class="list">
          <div class="lhead">Cashplannr</div>
          <div class="topic"><span class="chev">▾</span>583-integrations</div>
          <div v-for="b in branches" :key="b.name" class="row sub">
            <GitBranch class="ic" /><span class="nm">{{ b.name }}</span>
          </div>
          <div v-for="r in repos" :key="r.name" class="row" :class="{ sel: r.name === 'cashplannr-projects' }">
            <SquareDot class="ic" /><span class="nm">{{ r.name }}</span>
          </div>
        </div>
        <div class="right">
          <div class="bar"><b>cashplannr-projects</b><span class="br">main</span><span class="sp" /><span class="btn">Push</span><span class="btn">Catch up</span></div>
          <div class="tabs"><span>Diff</span><span>Code</span><span class="on">Servers</span><span>Journal</span><span>Terminal</span></div>
          <div class="pane">
            <div class="mini">Running</div>
            <div v-for="r in repos" :key="r.name" class="srow">
              <i class="dot" :class="r.srv" /><span class="nm">{{ r.name }}</span><span class="sp" /><span class="port">{{ r.where }}</span>
            </div>
            <div class="console">yarn run v1.22.22<br />$ quasar dev --port 8611</div>
          </div>
        </div>
      </div>
      <p class="note">Scoped to whatever the review column is on. No way to say “these three”.</p>
    </section>

    <!-- ── 1 ─────────────────────────────────────────────────────────── -->
    <section>
      <h2><b>1 · on the rows</b> — what §12 already describes. No new surface.</h2>
      <div class="win">
        <div class="rail"><i class="sq on" /><i class="sq" /><i class="sq" /></div>
        <div class="list">
          <div class="lhead">Cashplannr<span class="sp" /><span class="pips"><i class="p up" /><i class="p up" /><i class="p" /></span></div>
          <div class="topic">
            <span class="chev">▾</span>583-integrations
            <span class="sp" /><span class="pips"><i class="p up" /><i class="p start" /><i class="p" /></span>
          </div>
          <div v-for="b in branches" :key="b.name" class="row sub">
            <GitBranch class="ic" /><span class="nm">{{ b.name }}</span>
            <span class="sp" /><i v-if="b.srv !== 'none'" class="dot" :class="b.srv" />
          </div>
          <div v-for="r in repos" :key="r.name" class="row" :class="{ sel: r.name === 'cashplannr-projects' }">
            <SquareDot class="ic" /><span class="nm">{{ r.name }}</span>
            <span class="sp" /><i class="dot" :class="r.srv" />
          </div>
        </div>
        <div class="right">
          <div class="bar">
            <b>cashplannr-projects</b><span class="br">main</span><span class="sp" />
            <span class="btn go"><CirclePlay class="ic" />Start</span><span class="btn">Push</span><span class="btn">Catch up</span>
          </div>
          <div class="tabs"><span>Diff</span><span>Code</span><span class="on">Servers</span><span>Journal</span><span>Terminal</span></div>
          <div class="pane">
            <div class="mini">cashplannr-projects · down</div>
            <div class="console">yarn run v1.22.22<br />$ quasar dev --port 8611</div>
          </div>
        </div>
      </div>
      <p class="note">The dot is on every row you already read. <b>Start</b> in the bar acts on what is selected — a Repository, a Topic, the Project. The tab keeps only the console.</p>
    </section>

    <!-- ── 2 ─────────────────────────────────────────────────────────── -->
    <section>
      <h2><b>2 · a Servers drawer</b> — rows carry the state, a panel does the managing.</h2>
      <div class="win">
        <div class="rail"><i class="sq on" /><i class="sq" /><i class="sq" /><span class="sp" /><i class="sq srv"><Server class="ic" /></i></div>
        <div class="list drawer">
          <div class="dhead">Servers <span class="sp" /><span class="kbd">⌘⇧S</span></div>
          <label class="pick all"><i class="cb on">✓</i>Cashplannr<span class="sp" /><span class="port">2 up</span></label>
          <label v-for="r in repos" :key="r.name" class="pick">
            <i class="cb" :class="{ on: r.name !== 'cashplannr-projects' }">{{ r.name !== 'cashplannr-projects' ? '✓' : '' }}</i>
            <i class="dot" :class="r.srv" />{{ r.name }}<span class="sp" /><span class="port">{{ r.where }}</span>
          </label>
          <label class="pick ind"><i class="cb">&nbsp;</i><i class="dot" />projects · storybook<span class="sp" /><span class="port">:6006</span></label>
          <div class="dhead sub2">583-integrations <span class="sp" /><span class="port">1 up</span></div>
          <label v-for="b in branches" :key="b.name" class="pick">
            <i class="cb">&nbsp;</i><i class="dot" :class="b.srv" />{{ b.name }}<span class="sp" /><span class="port">{{ b.where }}</span>
          </label>
          <div class="dfoot"><span class="btn go"><CirclePlay class="ic" />Start 2</span><span class="btn"><CircleStop class="ic" />Stop all</span></div>
        </div>
        <div class="right dim">
          <div class="bar"><b>cashplannr-projects</b><span class="br">main</span><span class="sp" /><span class="btn">Push</span></div>
          <div class="tabs"><span class="on">Diff</span><span>Code</span><span>Servers</span><span>Journal</span></div>
          <div class="pane"><div class="ph" /><div class="ph s" /><div class="ph" /><div class="ph s" /></div>
        </div>
      </div>
      <p class="note">Over the list, one keystroke, gone again. Every server of the project — several per repo when there are several — with a tick each.</p>
    </section>

    <!-- ── 3 ─────────────────────────────────────────────────────────── -->
    <section>
      <h2><b>3 · a bottom strip</b> — always visible, expands to the same manager.</h2>
      <div class="win">
        <div class="rail"><i class="sq on" /><i class="sq" /><i class="sq" /></div>
        <div class="list">
          <div class="lhead">Cashplannr</div>
          <div class="topic"><span class="chev">▾</span>583-integrations</div>
          <div v-for="b in branches" :key="b.name" class="row sub">
            <GitBranch class="ic" /><span class="nm">{{ b.name }}</span>
            <span class="sp" /><i v-if="b.srv !== 'none'" class="dot" :class="b.srv" />
          </div>
          <div v-for="r in repos" :key="r.name" class="row" :class="{ sel: r.name === 'cashplannr-projects' }">
            <SquareDot class="ic" /><span class="nm">{{ r.name }}</span>
            <span class="sp" /><i class="dot" :class="r.srv" />
          </div>
        </div>
        <div class="right">
          <div class="bar"><b>cashplannr-projects</b><span class="br">main</span><span class="sp" /><span class="btn">Push</span><span class="btn">Catch up</span></div>
          <div class="tabs"><span class="on">Diff</span><span>Code</span><span>Journal</span><span>Terminal</span></div>
          <div class="pane"><div class="ph" /><div class="ph s" /><div class="ph" /></div>
        </div>
      </div>
      <div class="strip">
        <i class="dot up" /><b>2 running</b>
        <span class="port">v2 herd</span><span class="port">frontend :8543</span>
        <span class="sp" />
        <span class="btn go"><CirclePlay class="ic" />Start…</span><span class="btn"><CircleStop class="ic" />Stop all</span><span class="chev up">▴</span>
      </div>
      <p class="note">The “debug bar”. Costs 26px of every window forever; earns it only if servers are the thing you watch most.</p>
    </section>
  </div>
</template>

<style scoped>
.sheet {
  display: grid;
  /* Explicit columns: `1fr` never went below the sections' min-content and the
     sheet silently laid out twice as wide as the window. */
  grid-template-columns: repeat(2, 862px);
  gap: 30px 28px;
  padding: 26px;
  background: var(--bg-sunken);
  width: 1804px;
}
section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
h2 { font-size: 13px; font-weight: 400; color: var(--text-muted); margin: 0; }
h2 b { color: var(--text); font-weight: 600; }
.note { font-size: 12px; line-height: 1.5; color: var(--text-dim); margin: 0; }
.note b { color: var(--text-muted); font-weight: 500; }

.win {
  display: flex;
  height: 340px;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg);
  box-shadow: 0 1px 3px var(--sh-1);
  font-size: 13px;
}
.rail {
  width: 42px;
  flex: none;
  background: var(--surface-rail);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
}
.sq { width: 20px; height: 20px; border-radius: 6px; background: var(--line-strong); display: grid; place-items: center; }
.sq.on { background: var(--accent); }
.sq.srv { background: var(--accent-soft); color: var(--accent); }

.list {
  width: 240px;
  flex: none;
  background: var(--surface-nav);
  border-right: 1px solid var(--line);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.lhead { display: flex; align-items: center; height: 26px; padding: 0 6px; color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.topic { display: flex; align-items: center; gap: 5px; height: 28px; padding: 0 6px; color: var(--text); font-weight: 500; font-size: 13px; }
.chev { color: var(--text-dim); font-size: 10px; }
.row { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px; border-radius: 5px; color: var(--text-muted); }
.row.sub { padding-left: 20px; }
.row.sel { background: var(--selected); color: var(--text); }
.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ic { width: 13px; height: 13px; flex: none; }
.sp { flex: 1; }

.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--line-strong); }
.dot.up { background: var(--ok); }
.dot.starting, .dot.start { background: var(--warn); }
.pips { display: flex; gap: 3px; }
.p { width: 5px; height: 5px; border-radius: 50%; background: var(--line-strong); }
.p.up { background: var(--ok); }
.p.start { background: var(--warn); }

.right { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--surface-review); }
.right.dim { opacity: 0.45; }
.bar { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border-bottom: 1px solid var(--line); background: var(--surface-bar); }
.bar b { font-weight: 600; color: var(--text); }
.br { font-family: var(--mono); font-size: 11px; color: var(--text-dim); }
.btn { display: flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 5px; border: 1px solid var(--line); color: var(--text-muted); font-size: 12px; }
.btn.go { border-color: transparent; background: var(--accent); color: var(--accent-text); }
.tabs { display: flex; gap: 14px; height: 30px; align-items: center; padding: 0 12px; border-bottom: 1px solid var(--line-soft); color: var(--text-dim); font-size: 12px; }
.tabs .on { color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
.pane { flex: 1; padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
.mini { color: var(--text-dim); font-size: 11px; height: 18px; }
.srow { display: flex; align-items: center; gap: 8px; height: 24px; color: var(--text-muted); }
.port { font-family: var(--mono); font-size: 11px; color: var(--text-muted); background: var(--hover); border-radius: 4px; padding: 1px 6px; }
.console { margin-top: 6px; border-top: 1px solid var(--line-soft); padding-top: 6px; font-family: var(--mono); font-size: 11px; line-height: 1.6; color: var(--text-dim); }
.ph { height: 9px; border-radius: 3px; background: var(--hover); }
.ph.s { width: 60%; }

/* the drawer */
.drawer { background: var(--overlay); border-right: 1px solid var(--line-strong); box-shadow: 3px 0 12px var(--sh-2); }
.dhead { display: flex; align-items: center; height: 28px; padding: 0 6px; color: var(--text); font-weight: 600; font-size: 12px; }
.dhead.sub2 { color: var(--text-dim); font-weight: 400; margin-top: 6px; border-top: 1px solid var(--line-overlay); }
.kbd { font-family: var(--mono); font-size: 10px; color: var(--text-dim); border: 1px solid var(--line-overlay); border-radius: 4px; padding: 1px 4px; }
.pick { white-space: nowrap; display: flex; align-items: center; gap: 7px; height: 26px; padding: 0 6px; border-radius: 5px; color: var(--text-muted); font-size: 12px; }
.pick.all { color: var(--text); font-weight: 500; }
.pick.ind { padding-left: 24px; }
.cb { width: 13px; height: 13px; flex: none; border: 1px solid var(--line-strong); border-radius: 3px; font-size: 9px; display: grid; place-items: center; color: transparent; }
.cb.on { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.dfoot { margin-top: auto; display: flex; gap: 6px; padding: 8px 4px 2px; border-top: 1px solid var(--line-overlay); }

/* the strip */
.strip {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  margin-top: -1px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 0 0 10px 10px;
  background: var(--surface-bar);
  color: var(--text-muted);
  font-size: 12px;
}
.strip b { color: var(--text); font-weight: 500; }
.strip .btn { height: 18px; font-size: 11px; }
.strip .chev.up { color: var(--text-dim); }
</style>

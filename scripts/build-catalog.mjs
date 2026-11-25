#!/usr/bin/env node
// Builds the catalog of the skills, agents, and standards under .claude/ as two
// self-contained files. Everything on the page is read from the markdown files, except
// PIPELINE and LOOPS below, which describe the workflow diagram by hand.
//
//   docs/catalog.html         the standalone page, opened straight from the repository
//   docs/catalog.hosted.html  the same page for claude.ai, with the shared issue log
//
//   node scripts/build-catalog.mjs
//
// No dependencies. Run it again after editing an agent, a skill, or a standard.
//
// The issue log needs shared storage, so it only works in the hosted copy: a claude.ai
// artifact published from docs/catalog.hosted.html with the db and user capabilities.
// To update the hosted copy after a rebuild, ask Claude Code to publish
// docs/catalog.hosted.html to HOSTED_URL. Its capabilities and stored issues carry over.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_DIR = join(ROOT, '.claude/agents');
const SKILLS_DIR = join(ROOT, '.claude/skills');
const STANDARDS_DIR = join(ROOT, '.claude/standards');
const OUT_FILE = join(ROOT, 'docs/catalog.html');
const HOSTED_FILE = join(ROOT, 'docs/catalog.hosted.html');
// The published artifact. The standalone page links here for the issue log.
const HOSTED_URL = 'https://claude.ai/artifact/GuzZVHthphUoZGT8W1pvwB';

// The workflow diagram. Seven columns; the CSS for the two loop brackets assumes the
// developer is column 2, the QA gate column 4, and the review gate column 6.
const PIPELINE = [
  { kind: 'analysis', tag: 'Analysis', label: 'Mockup analysis', agents: ['analyst'] },
  { kind: 'build', tag: 'Build', label: 'UI development', agents: ['developer'] },
  {
    kind: 'qa',
    tag: 'QA',
    label: 'QA, in parallel',
    agents: ['visual-qa', 'behavior-qa', 'responsive-qa'],
  },
  { gate: true, label: 'QA gate', note: 'All three pass on the same pass' },
  { kind: 'review', tag: 'Review', label: 'Final code review', agents: ['code-reviewer'] },
  { gate: true, label: 'Review gate', note: 'No Critical or High finding' },
  { end: true, label: 'Ready for human review', note: 'You review the diff, commit, and open the PR' },
];
const LOOPS = {
  qa: 'Fails: the lead merges every finding into one fix list, the developer fixes, and all three QA engineers run again. Up to 3 QA passes.',
  review: 'Critical or High findings: a fix round, the QA gate again, then a new review. Up to 3 review rounds.',
};

// ---------------------------------------------------------------------------
// Reading

const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const rel = (file) => relative(ROOT, file).split('\\').join('/');

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return name.endsWith('.md') ? [full] : [];
    });
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { data: {}, body: text };
  const data = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    data[line.slice(0, colon).trim()] = line
      .slice(colon + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2');
  }
  return { data, body: text.slice(match[0].length) };
}

// Splits a markdown table row into cells, ignoring pipes inside code spans.
function splitRow(line) {
  const cells = [];
  let cell = '';
  let inCode = false;
  const text = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '`') inCode = !inCode;
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

const isTableStart = (lines, i) =>
  lines[i].trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]);

// Every table in a document, as { headers, rows } with raw cell text. Fenced code is skipped.
function parseTables(md) {
  const lines = md.split('\n');
  const tables = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence || !isTableStart(lines, i)) continue;
    const headers = splitRow(lines[i]).map((h) => h.toLowerCase());
    const rows = [];
    i += 2;
    while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
    tables.push({ headers, rows });
  }
  return tables;
}

// The text under a "## heading", up to the next heading of the same level.
function sectionOf(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start === -1) return '';
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

const stripFences = (md) => md.replace(/^\s*```[\s\S]*?^\s*```\s*$/gm, '');
const unquote = (cell) => cell.replace(/`/g, '').trim();
const codeSpans = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// Markdown to HTML (the subset these files use)

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(src) {
  const codes = [];
  let s = src.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

const FENCE = /^(\s*)(```+|~~~+)\s*(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const blank = (line) => /^\s*$/.test(line);

function renderList(items) {
  let pos = 0;
  const level = (indent) => {
    const { ordered, num } = items[pos];
    let html = ordered ? `<ol${num !== 1 ? ` start="${num}"` : ''}>` : '<ul>';
    while (pos < items.length && items[pos].indent >= indent) {
      if (items[pos].indent > indent) {
        html += `<li>${level(items[pos].indent)}</li>`;
        continue;
      }
      html += `<li>${inline(items[pos++].text)}`;
      if (pos < items.length && items[pos].indent > indent) html += level(items[pos].indent);
      html += '</li>';
    }
    return html + (ordered ? '</ol>' : '</ul>');
  };
  return level(items[0].indent);
}

// headingShift 1 turns "## x" into <h3>, so a document sits under the page's own headings.
function renderMarkdown(md, headingShift = 1) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;

  const startsBlock = (idx) =>
    FENCE.test(lines[idx]) ||
    HEADING.test(lines[idx]) ||
    RULE.test(lines[idx]) ||
    LIST_ITEM.test(lines[idx]) ||
    /^\s*>/.test(lines[idx]) ||
    isTableStart(lines, idx);

  while (i < lines.length) {
    const line = lines[i];
    let m;

    if (blank(line)) {
      i++;
    } else if ((m = line.match(FENCE))) {
      const [, indent, marker] = m;
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        code.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i]);
        i++;
      }
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if ((m = line.match(HEADING))) {
      const lvl = Math.min(6, m[1].length + headingShift);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      i++;
    } else if (RULE.test(line)) {
      out.push('<hr>');
      i++;
    } else if (isTableStart(lines, i)) {
      const headers = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
      const label = esc(`Table: ${headers.map(unquote).join(', ')}`);
      out.push(
        `<div class="table-wrap" tabindex="0" role="region" aria-label="${label}"><table><thead><tr>` +
          headers.map((h) => `<th scope="col">${inline(h)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>',
      );
    } else if (LIST_ITEM.test(line)) {
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (blank(cur)) {
          let next = i + 1;
          while (next < lines.length && blank(lines[next])) next++;
          if (next < lines.length && (LIST_ITEM.test(lines[next]) || /^\s{2,}\S/.test(lines[next]))) {
            i = next;
            continue;
          }
          break;
        }
        const item = cur.match(LIST_ITEM);
        if (item) {
          items.push({
            indent: item[1].replace(/\t/g, '    ').length,
            ordered: /\d/.test(item[2]),
            num: parseInt(item[2], 10) || 1,
            text: item[3],
          });
        } else if (/^\s*(```|~~~)/.test(cur) || HEADING.test(cur) || isTableStart(lines, i)) {
          break;
        } else {
          items[items.length - 1].text += ` ${cur.trim()}`;
        }
        i++;
      }
      out.push(renderList(items));
    } else if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'), headingShift)}</blockquote>`);
    } else {
      const para = [line.trim()];
      i++;
      while (i < lines.length && !blank(lines[i]) && !startsBlock(i)) para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Model

const humanize = (name) => name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const firstSentence = (text) => {
  const end = text.search(/\.\s/);
  return end === -1 ? [text, ''] : [text.slice(0, end + 1), text.slice(end + 2).trim()];
};

function loadSkills() {
  if (!existsSync(SKILLS_DIR)) return [];
  const skills = readdirSync(SKILLS_DIR)
    .sort()
    .map((dir) => join(SKILLS_DIR, dir, 'SKILL.md'))
    .filter(existsSync)
    .map((file) => {
      const { data, body } = parseFrontmatter(read(file));
      const name = data.name || basename(dirname(file));
      return {
        id: `skill-${name}`,
        name,
        description: data.description || '',
        hint: data['argument-hint'] || '',
        userOnly: data['disable-model-invocation'] === 'true',
        mode: (body.match(/project mode `(\w+)`/i) || [])[1] || '',
        body,
        path: rel(file),
        flagDocs: parseFlagDocs(body),
      };
    });
  // A skill that tells the lead to read another skill's file follows that playbook.
  for (const skill of skills) {
    skill.base = skills.find((other) => other !== skill && skill.body.includes(`skills/${other.name}/SKILL.md`));
    skill.usage = parseHint(skill.hint);
  }
  return skills;
}

// "<a> <b> [optional] [--flag <value>]" into required, optional, and flags.
function parseHint(hint) {
  const usage = { required: [], optional: [], flags: [] };
  for (const token of hint.match(/\[[^\]]*\]|<[^>]*>|\S+/g) || []) {
    if (!token.startsWith('[')) {
      usage.required.push(token);
      continue;
    }
    const inner = token.slice(1, -1).trim();
    if (!inner.startsWith('--')) {
      usage.optional.push(inner);
      continue;
    }
    const space = inner.indexOf(' ');
    usage.flags.push(
      space === -1 ? { flag: inner, value: '' } : { flag: inner.slice(0, space), value: inner.slice(space + 1).trim() },
    );
  }
  return usage;
}

// List items of the form "- `--flag <value>`: what it does", possibly naming several flags.
function parseFlagDocs(body) {
  const docs = {};
  for (const line of stripFences(body).split('\n')) {
    const m = line.match(/^\s*[-*]\s+((?:`--[^`]+`(?:\s*,\s*|\s+and\s+)?)+)\s*:\s*(.+)$/);
    if (!m) continue;
    for (const [, flag] of m[1].matchAll(/`(--[a-z-]+)[^`]*`/g)) docs[flag] ??= m[2].trim();
  }
  return docs;
}

function loadTeams(skills) {
  const files = walk(AGENTS_DIR);
  const skillTables = skills.flatMap((s) => parseTables(s.body));
  const teams = new Map();
  const teamOf = (file) => {
    const dir = dirname(file);
    if (!teams.has(dir)) teams.set(dir, { id: `team-${basename(dir)}`, name: basename(dir), dir: rel(dir), agents: [] });
    return teams.get(dir);
  };

  for (const file of files) {
    const { data, body } = parseFrontmatter(read(file));
    const team = teamOf(file);
    if (!data.name) {
      if (basename(file).toLowerCase() !== 'readme.md') continue;
      team.readme = body;
      team.readmePath = rel(file);
      team.title = (body.match(/^#\s+(.+)$/m) || [])[1] || humanize(team.name);
      continue;
    }
    team.agents.push({
      id: `agent-${data.name}`,
      name: data.name,
      description: data.description || '',
      model: data.model || '',
      tools: data.tools || '',
      // The card title is the agent's name, so the page cannot drift from the definitions.
      title: data.name,
      body,
      path: rel(file),
    });
  }

  for (const team of teams.values()) {
    team.title ??= humanize(team.name);
    const tables = [...parseTables(team.readme || ''), ...skillTables];
    for (const agent of team.agents) {
      // Any table with an agent column contributes its other columns to that agent.
      const facts = {};
      for (const { headers, rows } of tables) {
        const key = headers.findIndex((h) => h === 'agent' || h === 'agent type');
        const row = key === -1 ? null : rows.find((r) => unquote(r[key] || '') === agent.name);
        if (row) headers.forEach((h, idx) => (facts[h] ??= row[idx] || ''));
      }
      agent.teammate = unquote(facts['teammate name'] || '') || agent.name;
      agent.role = facts.role || '';
      agent.edits = facts.edits || facts['owns (the only files it edits)'] || '';
      agent.runsWhen = facts['runs when'] || '';
      agent.talksTo = codeSpans(facts['talks to'] || '');
      agent.stage = PIPELINE.find((step) => step.agents?.includes(agent.name));
    }
  }
  // Agents appear in the order the workflow reaches them, then by name.
  const order = (agent) => {
    const step = PIPELINE.indexOf(agent.stage);
    return step === -1 ? PIPELINE.length : step + agent.stage.agents.indexOf(agent.name) / 100;
  };
  for (const team of teams.values()) {
    team.agents.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  }
  return [...teams.values()].filter((team) => team.agents.length);
}

function loadStandards(agents, skills) {
  return walk(STANDARDS_DIR).map((file) => {
    const text = read(file);
    const name = basename(file, '.md');
    const title = (text.match(/^#\s+(.+)$/m) || [])[1] || humanize(name);
    return {
      id: `standard-${name}`,
      name,
      title,
      objective: (sectionOf(text, 'Objective').split(/\n\s*\n/)[0] || '').trim(),
      sections: [...stripFences(text).matchAll(/^##\s+(\d+)\.\s+(.+)$/gm)].map((m) => m[2].trim()),
      usedByAgents: agents.filter((a) => a.body.includes(basename(file))),
      usedBySkills: skills.filter((s) => s.body.includes(basename(file))),
      body: text.replace(/^#\s+.+\n/, ''),
      path: rel(file),
    };
  });
}

// ---------------------------------------------------------------------------
// Page

const hrefTo = (path) => encodeURI(relative(dirname(OUT_FILE), join(ROOT, path)).split('\\').join('/'));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The hosted copy has no repository beside it, so its documents carry no link to the file.
const docTemplate = (id, title, path, html, hosted) =>
  `<template id="doc-${esc(id)}" data-title="${esc(title)}" data-path="${esc(path)}"${
    hosted ? '' : ` data-href="${esc(hrefTo(path))}"`
  }>\n${html}\n</template>`;

const readButton = (id, label) =>
  `<button type="button" class="button" data-doc="${esc(id)}">${esc(label)}</button>`;

function renderFlow(agentByName) {
  const steps = PIPELINE.map((step) => {
    const type = step.gate ? 'gate' : step.end ? 'end' : 'stage';
    const kind = step.kind ? ` flow__step--${step.kind}` : '';
    const agents = (step.agents || [])
      .map((name) => {
        const agent = agentByName.get(name);
        return agent
          ? `<li><a class="flow__agent" href="#${esc(agent.id)}">${esc(agent.name)}</a></li>`
          : `<li><span class="flow__agent">${esc(name)}</span></li>`;
      })
      .join('');
    return (
      `<li class="flow__step flow__step--${type}${kind}">` +
      `<span class="flow__label">${esc(step.label)}</span>` +
      (agents ? `<ul class="flow__agents">${agents}</ul>` : '') +
      (step.note ? `<span class="flow__note">${esc(step.note)}</span>` : '') +
      '</li>'
    );
  }).join('\n');
  return `<div class="flow">
<ol class="flow__steps">
${steps}
</ol>
<p class="flow__loop flow__loop--qa"><strong>QA gate loop.</strong> ${esc(LOOPS.qa)}</p>
<div class="flow__bracket" aria-hidden="true"></div>
<p class="flow__loop flow__loop--review"><strong>Review gate loop.</strong> ${esc(LOOPS.review)}</p>
</div>`;
}

function renderSkill(skill, teams, hosted) {
  const [lead, rest] = firstSentence(skill.description);
  const { required, optional, flags } = skill.usage;
  const command = [`/${skill.name}`, ...required].join(' ');
  const usageLine = [command, ...optional.map((o) => `[${o}]`)].join(' ');
  const playbook = skill.base || skill;
  const team = teams.find(
    (t) => playbook.body.includes(t.dir) || t.agents.some((a) => playbook.body.includes(a.name)),
  );

  const badges = [
    skill.mode && `<li class="badge">Project mode: ${esc(skill.mode)}</li>`,
    skill.userOnly && '<li class="badge" title="disable-model-invocation: Claude never starts it by itself">Run by you only</li>',
    skill.base && `<li class="badge">Follows <a href="#${esc(skill.base.id)}">/${esc(skill.base.name)}</a></li>`,
    team && `<li class="badge">Leads <a href="#agents">${plural(team.agents.length, 'agent')}</a></li>`,
    // Filled in by the issue log with this skill's open issues.
    hosted && `<li class="badge" data-issue-badge="${esc(skill.name)}" hidden><a href="#issues"></a></li>`,
  ].filter(Boolean);

  const options = flags
    .map(({ flag, value }) => {
      const own = skill.flagDocs[flag];
      const inherited = skill.base?.flagDocs[flag];
      const showInherited = inherited && (!own || /^as in the playbook/i.test(own));
      return (
        `<div class="options__item"><dt><code>${esc(flag)}${value ? ` ${esc(value)}` : ''}</code></dt><dd>` +
        (own ? `<p>${inline(own.replace(/^[a-z]/, (c) => c.toUpperCase()))}</p>` : '') +
        (showInherited ? `<p class="options__inherited">From /${esc(skill.base.name)}: ${inline(inherited)}</p>` : '') +
        (!own && !inherited ? '<p class="options__inherited">Described in the playbook.</p>' : '') +
        '</dd></div>'
      );
    })
    .join('\n');

  return `<article class="card card--skill" id="${esc(skill.id)}" data-card>
<header class="card__header">
<p class="card__tag card__tag--skill">Skill</p>
<h3 class="card__title card__title--command">/${esc(skill.name)}</h3>
</header>
<p class="card__lead">${inline(lead)}</p>
${rest ? `<p class="card__text">${inline(rest)}</p>` : ''}
<ul class="badges">${badges.join('')}</ul>
<div class="usage">
<pre class="usage__line"><code>${esc(usageLine)}</code></pre>
<button type="button" class="button button--small" data-copy="${esc(command)}">Copy</button>
</div>
${
  flags.length
    ? `<details class="options"><summary>${plural(flags.length, 'option')}</summary><dl class="options__list">\n${options}\n</dl></details>`
    : ''
}
<footer class="card__footer">
${readButton(skill.id, 'Read the playbook')}
<span class="card__path">${esc(skill.path)}</span>
</footer>
</article>`;
}

function renderAgent(agent, agentByTeammate) {
  const talksTo = agent.talksTo
    .map((name) => {
      const other = agentByTeammate.get(name);
      return other
        ? `<li><a class="chip" href="#${esc(other.id)}">${esc(other.name)}</a></li>`
        : `<li><span class="chip">${esc(name)}</span></li>`;
    })
    .join('');
  const tools = agent.tools
    ? agent.tools.split(',').map((t) => `<li><span class="chip">${esc(t.trim())}</span></li>`).join('')
    : '';
  const rows = [
    agent.edits && ['Edits', inline(agent.edits)],
    agent.runsWhen && ['Runs', inline(agent.runsWhen)],
    talksTo && ['Talks to', `<ul class="chips">${talksTo}</ul>`],
    ['Tools', tools ? `<ul class="chips">${tools}</ul>` : 'All tools'],
    ['Model', agent.model ? `<code>${esc(agent.model)}</code>` : 'Same as the session'],
  ].filter(Boolean);

  const kind = agent.stage?.kind || 'default';
  return `<article class="card card--agent" id="${esc(agent.id)}" data-card>
<header class="card__header">
<p class="card__tag card__tag--${esc(kind)}">${esc(agent.stage?.tag || 'Agent')}</p>
<h3 class="card__title card__title--command">${esc(agent.title)}</h3>${
    agent.teammate !== agent.name
      ? `\n<p class="card__names"><span>teammate</span> <code>${esc(agent.teammate)}</code></p>`
      : ''
  }
</header>
<p class="card__text">${inline(agent.role || agent.description)}</p>
<dl class="meta">
${rows.map(([term, value]) => `<div class="meta__row"><dt>${term}</dt><dd>${value}</dd></div>`).join('\n')}
</dl>
<footer class="card__footer">
${readButton(agent.id, 'Read the definition')}
<span class="card__path">${esc(agent.path)}</span>
</footer>
</article>`;
}

function renderStandard(standard) {
  const usedBy = [
    ...standard.usedBySkills.map((s) => `<li><a class="chip" href="#${esc(s.id)}">/${esc(s.name)}</a></li>`),
    ...standard.usedByAgents.map((a) => `<li><a class="chip" href="#${esc(a.id)}">${esc(a.name)}</a></li>`),
  ].join('');
  return `<article class="card card--standard" id="${esc(standard.id)}" data-card>
<header class="card__header">
<p class="card__tag card__tag--default">Standard</p>
<h3 class="card__title">${esc(standard.title)}</h3>
</header>
${standard.objective ? `<p class="card__text">${inline(standard.objective)}</p>` : ''}
${usedBy ? `<dl class="meta"><div class="meta__row"><dt>Used by</dt><dd><ul class="chips">${usedBy}</ul></dd></div></dl>` : ''}
${
  standard.sections.length
    ? `<details class="options"><summary>${plural(standard.sections.length, 'section')}</summary><ol class="sections">${standard.sections
        .map((s) => `<li>${inline(s)}</li>`)
        .join('')}</ol></details>`
    : ''
}
<footer class="card__footer">
${readButton(standard.id, 'Read the standard')}
<span class="card__path">${esc(standard.path)}</span>
</footer>
</article>`;
}

const ISSUES_LEAD =
  'Problems you hit while building, converting, or updating a UI with these skills. Say what went wrong so the skill, agent, or standard behind it can be fixed.';

// The issue log. The hosted copy gets the form and the live list; the standalone page,
// which has nowhere to store anything, links to the hosted copy once HOSTED_URL is set.
function renderIssues(skills, hosted) {
  if (!hosted) {
    if (!HOSTED_URL) return '';
    return `<section class="section" id="issues" data-overview>
<div class="container">
<div class="section__header">
<h2 class="section__title">Issues</h2>
</div>
<p class="section__lead">${ISSUES_LEAD} The log lives on the hosted copy of this catalog, where the whole team sees the same list.</p>
<a class="button" href="${esc(HOSTED_URL)}#issues" rel="noopener">Open the issue log</a>
</div>
</section>`;
  }
  const options = [
    ...skills.map((s) => `<option value="${esc(s.name)}">/${esc(s.name)}</option>`),
    '<option value="other">Other</option>',
  ].join('');
  return `<section class="section" id="issues" data-overview>
<div class="container">
<div class="section__header">
<h2 class="section__title">Issues</h2>
<span class="section__count" id="issue-total" hidden></span>
</div>
<p class="section__lead">${ISSUES_LEAD}</p>
<div class="issues">
<form class="issue-form" id="issue-form">
<fieldset class="issue-form__fields" id="issue-fields" disabled>
<h3 class="issue-form__title">Report an issue</h3>
<div class="field">
<label class="field__label" for="issue-skill">Skill you ran</label>
<select class="field__control" id="issue-skill">${options}</select>
</div>
<div class="field">
<label class="field__label" for="issue-target">Frame or page <span class="field__hint">(optional)</span></label>
<input class="field__control" id="issue-target" type="text" maxlength="120" placeholder="clr-0 or Pricing.vue" autocomplete="off">
</div>
<div class="field">
<label class="field__label" for="issue-text">What went wrong</label>
<textarea class="field__control" id="issue-text" rows="6" maxlength="4000" placeholder="What you ran, what you expected, and what happened instead."></textarea>
</div>
<div class="issue-form__actions">
<button type="submit" class="button button--primary">Post issue</button>
<p class="issue-form__status" id="issue-form-status" role="status"></p>
</div>
</fieldset>
</form>
<p class="issue-access" id="issue-access" hidden></p>
<div class="issue-panel">
<div class="issue-toolbar">
<div class="issue-tabs" role="group" aria-label="Show issues">
<button type="button" class="issue-tab" data-issue-status="open" aria-pressed="true">Open</button>
<button type="button" class="issue-tab" data-issue-status="resolved" aria-pressed="false">Resolved</button>
<button type="button" class="issue-tab" data-issue-status="all" aria-pressed="false">All</button>
</div>
<label class="visually-hidden" for="issue-filter-skill">Show issues for</label>
<select class="field__control" id="issue-filter-skill"><option value="">All skills</option>${options}</select>
</div>
<p class="issue-note" id="issue-note" role="status">Loading issues…</p>
<ol class="issue-list" id="issue-list"></ol>
</div>
</div>
</div>
</section>`;
}

const DARK_TOKENS = `
  color-scheme: dark;
  --bg: #0f1115;
  --surface: #171a21;
  --surface-sunken: #1f232c;
  --text: #e8eaef;
  --muted: #9ba4b3;
  --line: #2a2f3a;
  --line-strong: #4a5263;
  --accent: #93a5fb;
  --accent-soft: #1f2644;
  --analysis: #c4b5fd;
  --analysis-soft: #2a2145;
  --build: #93c5fd;
  --build-soft: #172a4a;
  --qa: #fcd34d;
  --qa-soft: #3a2c0c;
  --review: #86efac;
  --review-soft: #12301d;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
`;

const CSS = String.raw`
:root {
  color-scheme: light;
  --bg: #f5f6f8;
  --surface: #ffffff;
  --surface-sunken: #eef0f4;
  --text: #16181d;
  --muted: #586070;
  --line: #dfe3e9;
  --line-strong: #aab2c0;
  --accent: #3451d1;
  --accent-soft: #ebefff;
  --analysis: #6d28d9;
  --analysis-soft: #f1e9ff;
  --build: #1d4ed8;
  --build-soft: #e6eeff;
  --qa: #8a4b08;
  --qa-soft: #fcefd6;
  --review: #166534;
  --review-soft: #e1f5e7;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.05);
  --radius: 12px;
  --header-height: 60px;
  --flow-gap: 28px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
/* Dark follows the system setting unless the viewer picked a theme: claude.ai sets data-theme on the root for that. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK_TOKENS}}
}
:root[data-theme="dark"] {${DARK_TOKENS}}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { scroll-behavior: smooth; scroll-padding-top: calc(var(--header-height) + 16px); }
html:has(dialog[open]) { overflow: hidden; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 var(--font); -webkit-text-size-adjust: 100%; }
h1, h2, h3, h4, h5, h6, p, ul, ol, dl, dd, pre, blockquote { margin: 0; }
ul, ol { padding: 0; list-style: none; }
a { color: var(--accent); text-underline-offset: 2px; }
code, pre { font-family: var(--mono); font-size: 0.9em; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.skip-link { position: absolute; left: 16px; top: -48px; z-index: 30; padding: 8px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.skip-link:focus { top: 8px; }
/* The gutter is padding, not width, so it can also clear a phone's side system bar. */
.container { width: 100%; max-width: 1232px; margin-inline: auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }

body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bg); }
.site-header { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 20; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
.site-header__inner { display: flex; align-items: center; gap: 12px 24px; min-height: var(--header-height); }
.site-header__brand { font-weight: 650; color: var(--text); text-decoration: none; white-space: nowrap; }
.site-nav { margin-right: auto; }
.site-nav__list { display: flex; gap: 4px; }
.site-nav__link { display: block; padding: 6px 10px; border-radius: 8px; color: var(--muted); text-decoration: none; font-weight: 500; }
.site-nav__link:hover { color: var(--text); background: var(--surface-sunken); }
.search { position: relative; flex: 0 1 300px; }
.search__input { width: 100%; height: 36px; padding: 0 34px 0 12px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; }
.search__input::placeholder { color: var(--muted); }
.search__key { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); padding: 0 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--muted); font: 12px/18px var(--mono); pointer-events: none; }
.search__input:focus + .search__key, .search__input:not(:placeholder-shown) + .search__key { display: none; }

.hero { padding: 48px 0 8px; }
.hero__title { font-size: clamp(28px, 4vw, 40px); line-height: 1.15; letter-spacing: -0.02em; }
.hero__lead { max-width: 68ch; margin-top: 12px; color: var(--muted); font-size: 17px; }
.stats { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
.stats__item { display: block; min-width: 132px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); color: var(--text); text-decoration: none; box-shadow: var(--shadow); }
.stats__item:hover { border-color: var(--line-strong); }
.stats__value { display: block; font-size: 26px; font-weight: 650; line-height: 1.2; }
.stats__label { color: var(--muted); }

.section { padding: 40px 0 8px; }
.section__header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-bottom: 6px; }
.section__title { font-size: 22px; letter-spacing: -0.01em; }
.section__count { padding: 1px 9px; border-radius: 999px; background: var(--surface-sunken); color: var(--muted); font-size: 13px; font-weight: 600; }
.section__action { margin-left: auto; }
.section__lead { max-width: 76ch; margin-bottom: 20px; color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 16px; }

.card { display: flex; flex-direction: column; gap: 14px; padding: 20px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); min-width: 0; }
.card:target { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.card__header { display: grid; gap: 6px; justify-items: start; }
.card__tag { padding: 1px 8px; border-radius: 6px; background: var(--surface-sunken); color: var(--muted); font-size: 12px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; }
.card__tag--skill { background: var(--accent-soft); color: var(--accent); }
.card__tag--analysis { background: var(--analysis-soft); color: var(--analysis); }
.card__tag--build { background: var(--build-soft); color: var(--build); }
.card__tag--qa { background: var(--qa-soft); color: var(--qa); }
.card__tag--review { background: var(--review-soft); color: var(--review); }
.card__title { font-size: 18px; line-height: 1.3; }
.card__title--command { font-family: var(--mono); font-size: 19px; }
.card__names { color: var(--muted); font-size: 13px; }
.card__names code, .card__text code, .card__lead code, .meta code, .options code { padding: 1px 5px; border-radius: 5px; background: var(--surface-sunken); color: var(--text); overflow-wrap: anywhere; }
.card__lead { font-weight: 500; }
.card__text { color: var(--muted); }
.card__footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: auto; padding-top: 14px; border-top: 1px solid var(--line); }
.card__path { color: var(--muted); font: 12px/1.4 var(--mono); overflow-wrap: anywhere; }

.badges, .chips { display: flex; flex-wrap: wrap; gap: 6px; }
.badge { padding: 2px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 13px; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 6px; background: var(--surface-sunken); color: var(--text); font: 12.5px/1.6 var(--mono); text-decoration: none; }
a.chip:hover { background: var(--accent-soft); color: var(--accent); }

.meta { display: grid; gap: 8px; font-size: 14px; }
.meta__row { display: grid; grid-template-columns: 72px 1fr; gap: 12px; }
.meta dt { color: var(--muted); }
.meta dd { min-width: 0; }

.usage { display: flex; align-items: flex-start; gap: 8px; padding: 10px 10px 10px 12px; background: var(--surface-sunken); border-radius: 8px; }
.usage__line { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.6; }

.button { display: inline-block; padding: 7px 12px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--text); font: 500 14px/1.3 var(--font); text-decoration: none; cursor: pointer; }
.button:hover { border-color: var(--accent); color: var(--accent); }
.button--small { padding: 3px 9px; font-size: 13px; }
.button--primary, .button--primary:hover { border-color: var(--accent); background: var(--accent); color: var(--surface); }
.button--primary:hover { filter: brightness(1.1); }
.button:disabled { opacity: 0.55; cursor: default; }

.issues { display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: 16px; align-items: start; }
.issue-form, .issue-access, .issue-panel { min-width: 0; padding: 20px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.issue-access { color: var(--muted); }
.issue-form__fields { display: grid; gap: 14px; min-width: 0; margin: 0; padding: 0; border: 0; }
.issue-form__title { font-size: 16px; }
.issue-form__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.issue-form__status { color: var(--muted); font-size: 13px; }
.field { display: grid; gap: 5px; }
.field__label { font-size: 13px; font-weight: 600; }
.field__hint { color: var(--muted); font-weight: 400; }
.field__control { width: 100%; min-height: 36px; padding: 7px 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; }
.field__control::placeholder { color: var(--muted); }
textarea.field__control { min-height: 132px; line-height: 1.5; resize: vertical; }
.issue-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.issue-toolbar .field__control { width: auto; min-height: 32px; padding-block: 0; font-size: 13px; }
.issue-tabs { display: flex; gap: 4px; padding: 3px; border-radius: 9px; background: var(--surface-sunken); }
.issue-tab { padding: 4px 10px; border: 0; border-radius: 6px; background: none; color: var(--muted); font: 500 13px/1.4 var(--font); cursor: pointer; }
.issue-tab:hover { color: var(--text); }
.issue-tab[aria-pressed="true"] { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.issue-note { margin-top: 16px; color: var(--muted); font-size: 14px; }
.issue-list { margin-top: 4px; }
.issue { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; padding: 16px 0; border-top: 1px solid var(--line); }
.issue:first-child { border-top: 0; }
.issue:last-child { padding-bottom: 0; }
.issue__avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--surface-sunken); }
.issue__head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.issue__author { font-weight: 600; }
.issue__time { color: var(--muted); font-size: 13px; }
.issue__state { padding: 1px 8px; border-radius: 999px; background: var(--qa-soft); color: var(--qa); font-size: 12px; font-weight: 600; }
.issue__state--resolved { background: var(--review-soft); color: var(--review); }
.issue__text { margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.issue--resolved .issue__text { color: var(--muted); }
.issue__actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chip--skill { background: var(--accent-soft); color: var(--accent); }

.options summary { color: var(--accent); font-weight: 500; cursor: pointer; }
.options__list { display: grid; gap: 12px; margin-top: 12px; font-size: 14px; }
.options__item dd { margin-top: 4px; color: var(--muted); }
.options__item dd p + p { margin-top: 4px; }
.options__inherited { font-size: 13px; }
.sections { columns: 2; column-gap: 48px; margin-top: 12px; padding-left: 22px; list-style: decimal; color: var(--muted); font-size: 14px; }
.sections li { break-inside: avoid; padding-left: 2px; }

.flow { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0 var(--flow-gap); padding: 24px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.flow__steps { display: contents; }
.flow__step { position: relative; grid-row: 1; display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); }
.flow__step + .flow__step::before { content: ""; position: absolute; left: calc(var(--flow-gap) * -1 + 6px); top: 50%; width: calc(var(--flow-gap) - 12px); height: 10px; transform: translateY(-50%); background: var(--line-strong); clip-path: polygon(0 40%, 62% 40%, 62% 0, 100% 50%, 62% 100%, 62% 60%, 0 60%); }
.flow__step--analysis { border-top: 3px solid var(--analysis); }
.flow__step--build { border-top: 3px solid var(--build); }
.flow__step--qa { border-top: 3px solid var(--qa); }
.flow__step--review { border-top: 3px solid var(--review); }
.flow__step--gate { justify-content: center; border-style: dashed; border-color: var(--line-strong); background: transparent; }
.flow__step--end { justify-content: center; border-color: var(--review); background: var(--review-soft); }
.flow__label { font-weight: 650; font-size: 14px; line-height: 1.3; }
.flow__step--gate .flow__label::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 7px; background: var(--accent); transform: rotate(45deg) translateY(-1px); }
.flow__agents { display: grid; gap: 5px; justify-items: start; }
.flow__agent { display: inline-block; padding: 1px 7px; border-radius: 6px; background: var(--surface); border: 1px solid var(--line); color: var(--text); font: 12px/1.6 var(--mono); text-decoration: none; overflow-wrap: anywhere; }
a.flow__agent:hover { border-color: var(--accent); color: var(--accent); }
.flow__note { color: var(--muted); font-size: 12.5px; line-height: 1.4; }
.flow__loop { position: relative; color: var(--muted); font-size: 13px; line-height: 1.45; text-align: center; }
.flow__loop strong { color: var(--text); }
.flow__loop--qa { grid-row: 2; grid-column: 2 / 5; margin-inline: calc((100% - var(--flow-gap) * 2) / 6); padding: 16px 14px 12px; border: 1.5px dashed var(--line-strong); border-top: 0; border-radius: 0 0 12px 12px; }
.flow__bracket { position: relative; grid-row: 2 / 4; grid-column: 2 / 7; margin-left: calc((100% - var(--flow-gap) * 4) / 10 - 18px); margin-right: calc((100% - var(--flow-gap) * 4) / 10); border: 1.5px dashed var(--line-strong); border-top: 0; border-radius: 0 0 12px 12px; pointer-events: none; }
.flow__loop--qa::before, .flow__bracket::before { content: ""; position: absolute; left: -6.5px; top: -1px; border: 6px solid transparent; border-top: 0; border-bottom: 8px solid var(--line-strong); }
.flow__loop--review { grid-row: 3; grid-column: 2 / 7; margin-inline: calc((100% - var(--flow-gap) * 4) / 10 + 8px); padding: 14px 14px 12px; }

.notes { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 16px; margin-top: 16px; }
.notes__panel { padding: 20px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.notes__title { margin-bottom: 10px; font-size: 16px; }

.prose { overflow-wrap: anywhere; }
.prose > * + * { margin-top: 12px; }
.prose h3 { margin-top: 28px; font-size: 18px; }
.prose h4 { margin-top: 20px; font-size: 16px; }
.prose h5, .prose h6 { margin-top: 16px; font-size: 15px; }
.prose > :first-child { margin-top: 0; }
.prose ul, .prose ol { padding-left: 22px; }
.prose ul { list-style: disc; }
.prose ol { list-style: decimal; }
.prose li + li, .prose li > ul, .prose li > ol { margin-top: 6px; }
.prose code { padding: 1px 5px; border-radius: 5px; background: var(--surface-sunken); }
.prose pre { padding: 14px; border-radius: 8px; background: var(--surface-sunken); overflow-x: auto; line-height: 1.5; }
.prose pre code { padding: 0; background: none; overflow-wrap: normal; }
.prose hr { border: 0; border-top: 1px solid var(--line); margin-block: 24px; }
.prose blockquote { padding-left: 14px; border-left: 3px solid var(--line-strong); color: var(--muted); }
.prose--compact { color: var(--muted); font-size: 14px; }
.prose--compact strong { color: var(--text); }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
.table-wrap table { width: 100%; border-collapse: collapse; font-size: 14px; }
.table-wrap th, .table-wrap td { padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: normal; }
.table-wrap th { background: var(--surface-sunken); white-space: nowrap; }
.table-wrap td { min-width: 120px; }
.table-wrap tr:last-child td { border-bottom: 0; }

.empty { padding-block: 56px; color: var(--muted); text-align: center; }
.site-footer { margin-top: 56px; padding: 24px 0 40px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
.site-footer code { padding: 1px 5px; border-radius: 5px; background: var(--surface-sunken); }

.reader { width: min(100vw - 24px, 900px); max-width: none; height: min(100dvh - 24px, 1000px); max-height: none; padding: 0; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: 0 24px 64px rgba(0, 0, 0, 0.3); }
.reader[open] { display: flex; flex-direction: column; }
.reader::backdrop { background: rgba(10, 12, 16, 0.55); }
.reader__header { display: flex; align-items: flex-start; gap: 16px; padding: 18px 24px; border-bottom: 1px solid var(--line); }
.reader__heading { flex: 1; min-width: 0; }
.reader__title { font-size: 20px; line-height: 1.3; overflow-wrap: anywhere; }
.reader__path { color: var(--muted); font: 12.5px/1.5 var(--mono); overflow-wrap: anywhere; }
.reader__body:focus-visible { outline-offset: -2px; border-radius: 0 0 14px 14px; }
.reader__body { flex: 1; overflow-y: auto; padding: 24px; overscroll-behavior: contain; }

@media (max-width: 1023px) {
  .flow { display: block; padding: 16px; }
  .flow__steps { display: grid; gap: var(--flow-gap); }
  .flow__step { grid-row: auto; }
  .flow__step + .flow__step::before { left: 50%; top: calc(var(--flow-gap) * -1 + 4px); width: 10px; height: calc(var(--flow-gap) - 8px); transform: translateX(-50%); clip-path: polygon(40% 0, 60% 0, 60% 62%, 100% 62%, 50% 100%, 0 62%, 40% 62%); }
  .flow__agents { display: flex; flex-wrap: wrap; }
  .flow__bracket { display: none; }
  .flow__loop--qa, .flow__loop--review { margin: 12px 0 0; padding: 10px 12px; border: 1.5px dashed var(--line-strong); border-radius: 10px; text-align: left; }
  .flow__loop--qa::before { display: none; }
}
@media (max-width: 899px) {
  .issues { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 767px) {
  .site-header__inner { flex-wrap: wrap; padding-block: 10px; }
  .site-nav { order: 3; width: 100%; margin: 0; overflow-x: auto; }
  .search { flex: 1 1 160px; }
  .search__key { display: none; }
  .hero { padding-top: 32px; }
  .sections { columns: 1; }
  .reader__header, .reader__body { padding-inline: 16px; }
  html { scroll-padding-top: 120px; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
}
@media print {
  .site-header, .button, .search { display: none; }
}
`;

const JS = String.raw`
(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll('[data-card]'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('[data-section]'));
  var input = document.getElementById('catalog-search');
  var status = document.getElementById('catalog-status');
  var empty = document.getElementById('catalog-empty');
  var overview = document.querySelectorAll('[data-overview]');
  var reader = document.getElementById('reader');
  var readerTitle = document.getElementById('reader-title');
  var readerPath = document.getElementById('reader-path');
  var readerBody = document.getElementById('reader-body');

  // A card matches on its own text and on the full text of the document behind it.
  var index = cards.map(function (card) {
    var doc = document.getElementById('doc-' + card.id);
    return (card.textContent + ' ' + (doc ? doc.content.textContent : '')).toLowerCase();
  });

  function applyFilter() {
    var terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    var shown = 0;
    cards.forEach(function (card, i) {
      var match = terms.every(function (term) { return index[i].indexOf(term) !== -1; });
      card.hidden = !match;
      if (match) shown += 1;
    });
    sections.forEach(function (section) {
      var all = section.querySelectorAll('[data-card]').length;
      var visible = section.querySelectorAll('[data-card]:not([hidden])').length;
      section.querySelector('[data-count]').textContent = terms.length ? visible + ' of ' + all : String(all);
      section.hidden = terms.length > 0 && visible === 0;
    });
    Array.prototype.forEach.call(overview, function (el) { el.hidden = terms.length > 0; });
    empty.hidden = shown !== 0;
    status.textContent = terms.length ? shown + ' of ' + cards.length + ' shown' : '';
  }

  function clearFilter() {
    if (!input.value) return;
    input.value = '';
    applyFilter();
  }

  input.addEventListener('input', applyFilter);
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && input.value) {
      event.preventDefault();
      clearFilter();
    }
  });
  input.form.addEventListener('submit', function (event) { event.preventDefault(); });

  document.addEventListener('keydown', function (event) {
    var tag = event.target.tagName;
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || reader.open) return;
    event.preventDefault();
    input.focus();
  });

  // Following a link to a card that the filter is hiding clears the filter first.
  function revealTarget() {
    var target = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    if (!target) return;
    if (target.hidden || target.closest('[hidden]')) {
      clearFilter();
      target.scrollIntoView();
    }
  }
  window.addEventListener('hashchange', revealTarget);

  function openDoc(id) {
    var doc = document.getElementById('doc-' + id);
    if (!doc) return;
    readerTitle.textContent = doc.getAttribute('data-title');
    readerPath.textContent = doc.getAttribute('data-path');
    var href = doc.getAttribute('data-href');
    if (href) readerPath.href = href; else readerPath.removeAttribute('href');
    readerBody.replaceChildren(doc.content.cloneNode(true));
    reader.showModal();
    readerBody.scrollTop = 0;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.className = 'visually-hidden';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      area.remove();
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  document.addEventListener('click', function (event) {
    var opener = event.target.closest('[data-doc]');
    if (opener) {
      openDoc(opener.getAttribute('data-doc'));
      return;
    }
    var copier = event.target.closest('[data-copy]');
    if (copier) {
      copyText(copier.getAttribute('data-copy')).then(
        function () { flash(copier, 'Copied'); },
        function () { flash(copier, 'Copy failed'); }
      );
      return;
    }
    if (event.target.closest('[data-close]') || event.target === reader) reader.close();
  });

  function flash(button, text) {
    var original = button.getAttribute('data-label') || button.textContent;
    button.setAttribute('data-label', original);
    button.textContent = text;
    setTimeout(function () { button.textContent = original; }, 1500);
  }

  applyFilter();
})();
`;

// The issue log, hosted copy only. Storage is the artifact's db capability: one document
// per author at issues/<author id>, holding every issue that person posted under "items".
// The access rules let everyone read, each person write their own document, and the
// artifact's owner write any of them. Everything read back is other people's input, so
// it only ever reaches the page through textContent.
const ISSUES_JS = String.raw`
(function () {
  var section = document.getElementById('issues');
  var form = document.getElementById('issue-form');
  if (!section || !form) return;
  var fields = document.getElementById('issue-fields');
  var skillInput = document.getElementById('issue-skill');
  var targetInput = document.getElementById('issue-target');
  var textInput = document.getElementById('issue-text');
  var formStatus = document.getElementById('issue-form-status');
  var access = document.getElementById('issue-access');
  var note = document.getElementById('issue-note');
  var list = document.getElementById('issue-list');
  var total = document.getElementById('issue-total');
  var skillFilter = document.getElementById('issue-filter-skill');
  var tabs = Array.prototype.slice.call(section.querySelectorAll('[data-issue-status]'));
  var badges = Array.prototype.slice.call(document.querySelectorAll('[data-issue-badge]'));

  var db = null;
  var user = null;
  var me = null;
  var canPost = false;
  var issues = [];
  var loaded = false;
  var problem = '';
  var busy = false;
  var confirming = '';
  var filter = { status: 'open', skill: '' };
  var drawn = 0;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function collect(snap) {
    var out = [];
    snap.docs.forEach(function (doc) {
      var items = (doc.data() || {}).items;
      if (!items || typeof items !== 'object') return;
      Object.keys(items).forEach(function (id) {
        var item = items[id];
        if (!item || typeof item !== 'object' || item.deleted || typeof item.text !== 'string' || !item.text) return;
        out.push({
          author: doc.id,
          id: id,
          skill: typeof item.skill === 'string' ? item.skill.slice(0, 40) : 'other',
          target: typeof item.target === 'string' ? item.target.slice(0, 120) : '',
          text: item.text.slice(0, 4000),
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
          resolved: item.status === 'resolved'
        });
      });
    });
    // Newest first.
    out.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; });
    return out;
  }

  function formatDate(iso) {
    var date = new Date(iso);
    if (!iso || isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function actionButton(issue, action, label) {
    var button = el('button', 'button button--small', label);
    button.type = 'button';
    button.setAttribute('data-issue-action', action);
    button.setAttribute('data-author', issue.author);
    button.setAttribute('data-id', issue.id);
    return button;
  }

  function row(issue, person) {
    var item = el('li', 'issue' + (issue.resolved ? ' issue--resolved' : ''));
    var avatar = el(person && person.avatarUrl ? 'img' : 'span', 'issue__avatar');
    if (person && person.avatarUrl) {
      avatar.alt = '';
      avatar.width = 28;
      avatar.height = 28;
      avatar.src = person.avatarUrl;
    }
    item.appendChild(avatar);

    var main = el('div', 'issue__main');
    var head = el('div', 'issue__head');
    head.appendChild(el('span', 'issue__author', (person && person.name) || 'Someone'));
    head.appendChild(el('span', 'chip chip--skill', issue.skill === 'other' ? 'Other' : '/' + issue.skill));
    if (issue.target) head.appendChild(el('span', 'chip', issue.target));
    head.appendChild(el('span', 'issue__state' + (issue.resolved ? ' issue__state--resolved' : ''), issue.resolved ? 'Resolved' : 'Open'));
    var when = formatDate(issue.createdAt);
    if (when) {
      var time = el('time', 'issue__time', when);
      time.dateTime = issue.createdAt;
      head.appendChild(time);
    }
    main.appendChild(head);
    main.appendChild(el('p', 'issue__text', issue.text));

    // The author and the catalog's owner can resolve, reopen, or delete an issue.
    if (canPost && me && (me.id === issue.author || me.isOwner)) {
      var actions = el('div', 'issue__actions');
      if (confirming === issue.author + '/' + issue.id) {
        actions.appendChild(actionButton(issue, 'delete', 'Confirm delete'));
        actions.appendChild(actionButton(issue, 'cancel', 'Cancel'));
      } else {
        actions.appendChild(actionButton(issue, issue.resolved ? 'reopen' : 'resolve', issue.resolved ? 'Reopen' : 'Mark resolved'));
        actions.appendChild(actionButton(issue, 'delete', 'Delete'));
      }
      main.appendChild(actions);
    }
    item.appendChild(main);
    return item;
  }

  function render() {
    var open = issues.filter(function (issue) { return !issue.resolved; });
    total.textContent = open.length + ' open';
    total.hidden = !loaded;
    badges.forEach(function (badge) {
      var skill = badge.getAttribute('data-issue-badge');
      var count = open.filter(function (issue) { return issue.skill === skill; }).length;
      badge.querySelector('a').textContent = count + (count === 1 ? ' open issue' : ' open issues');
      badge.hidden = count === 0;
    });
    tabs.forEach(function (tab) {
      tab.setAttribute('aria-pressed', String(tab.getAttribute('data-issue-status') === filter.status));
    });

    var shown = issues.filter(function (issue) {
      if (filter.skill && issue.skill !== filter.skill) return false;
      return filter.status === 'all' || (filter.status === 'resolved') === issue.resolved;
    });
    var authors = shown
      .map(function (issue) { return issue.author; })
      .filter(function (id, i, all) { return all.indexOf(id) === i; });
    // Names are looked up on every draw and never stored: they differ per viewer and go stale.
    var turn = ++drawn;
    var lookup = user && authors.length ? user.profiles(authors) : Promise.resolve({});
    lookup.then(function (people) {
      if (turn !== drawn) return;
      list.replaceChildren.apply(list, shown.map(function (issue) { return row(issue, people[issue.author]); }));
      var message = problem;
      if (!message && !loaded) message = 'Loading issues…';
      if (!message && !shown.length) {
        message = issues.length
          ? 'No issues match these filters.'
          : 'No issues logged yet.' + (canPost ? ' Report the first one with the form.' : '');
      }
      note.textContent = message;
      note.hidden = !message;
    });
  }

  function saveError(error) {
    var code = error && error.code;
    if (code === 'invalid_argument') return 'That could not be saved. You may only have view access: ask the catalog owner for Contributor access.';
    if (code === 'quota_exceeded') return 'The issue log is full. Ask the catalog owner to delete old issues.';
    if (code === 'resource_exhausted') return 'Too many changes at once. Wait a moment and try again.';
    return 'That could not be saved. Try again in a moment.';
  }

  // Merges one issue into its author's document, creating the document on their first post.
  // A merge only touches that issue, so two people changing different issues never collide.
  function write(author, id, patch) {
    var ref = db.collection('issues').doc(author);
    var body = { items: {} };
    body.items[id] = patch;
    var attempt = function () {
      return ref.get().then(function (snap) { return snap.exists ? ref.update(body) : ref.set(body); });
    };
    busy = true;
    return attempt()
      .catch(function (error) {
        if (!error || error.code !== 'unavailable') throw error;
        return new Promise(function (resolve) { setTimeout(resolve, 400 + Math.random() * 800); }).then(attempt);
      })
      .then(
        function () { busy = false; },
        function (error) { busy = false; throw error; }
      );
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy || !canPost) return;
    var text = textInput.value.trim();
    if (!text) {
      formStatus.textContent = 'Describe what went wrong before posting.';
      textInput.focus();
      return;
    }
    var skill = skillInput.value;
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    fields.disabled = true;
    formStatus.textContent = 'Posting…';
    write(me.id, id, {
      skill: skill,
      target: targetInput.value.trim(),
      text: text,
      createdAt: new Date().toISOString(),
      status: 'open'
    }).then(
      function () {
        textInput.value = '';
        targetInput.value = '';
        formStatus.textContent = 'Posted.';
        fields.disabled = false;
        // Make sure the new issue is in view.
        filter.status = 'open';
        if (filter.skill && filter.skill !== skill) {
          filter.skill = '';
          skillFilter.value = '';
        }
        render();
      },
      function (error) {
        formStatus.textContent = saveError(error);
        fields.disabled = false;
      }
    );
  });

  list.addEventListener('click', function (event) {
    var button = event.target.closest('[data-issue-action]');
    if (!button || busy) return;
    var action = button.getAttribute('data-issue-action');
    var author = button.getAttribute('data-author');
    var id = button.getAttribute('data-id');
    // Deleting takes a second click on "Confirm delete".
    if (action === 'cancel' || (action === 'delete' && confirming !== author + '/' + id)) {
      confirming = action === 'cancel' ? '' : author + '/' + id;
      render();
      return;
    }
    confirming = '';
    var patch = action === 'delete'
      ? { deleted: true, text: '', target: '' }
      : { status: action === 'resolve' ? 'resolved' : 'open' };
    write(author, id, patch).then(
      function () { problem = ''; render(); },
      function (error) { problem = saveError(error); render(); }
    );
  });

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      filter.status = tab.getAttribute('data-issue-status');
      render();
    });
  });
  skillFilter.addEventListener('change', function () {
    filter.skill = skillFilter.value;
    render();
  });

  // A skill card's "open issues" badge opens the log filtered to that skill.
  document.addEventListener('click', function (event) {
    var link = event.target.closest('[data-issue-badge] a');
    if (!link) return;
    filter.status = 'open';
    filter.skill = link.parentNode.getAttribute('data-issue-badge');
    skillFilter.value = filter.skill;
    render();
  });

  function readOnly(message) {
    canPost = false;
    form.hidden = true;
    access.textContent = message;
    access.hidden = false;
  }

  function unavailable() {
    readOnly('Open this catalog in claude.ai while signed in to read and post issues.');
    note.hidden = true;
  }

  if (!window.claude || typeof window.claude.use !== 'function') {
    unavailable();
    return;
  }
  Promise.all([window.claude.use('db'), window.claude.use('user')]).then(function (found) {
    db = found[0];
    user = found[1];
    if (!db) {
      unavailable();
      return;
    }

    var who = user ? Promise.all([user.me(), user.can('data.write')]) : Promise.resolve([null, false]);
    who.then(function (answers) {
      me = answers[0];
      // No answer about write access is not a "no": keep the form and let a refused save decide.
      if (me && me.id && answers[1] !== false) {
        canPost = true;
        fields.disabled = false;
      } else {
        readOnly('You can read the issues here. To post one, ask the catalog owner for Contributor access.');
      }
      render();
    });

    var slow = setTimeout(function () {
      problem = 'Still trying to reach the issue log. What is shown may be out of date.';
      render();
    }, 10000);
    db.collection('issues').onSnapshot(
      function (snap) {
        issues = collect(snap);
        loaded = true;
        if (!snap.metadata.fromCache) {
          clearTimeout(slow);
          problem = '';
        }
        render();
      },
      function (error) {
        clearTimeout(slow);
        loaded = true;
        problem = error && error.code === 'revoked'
          ? 'The issue log is no longer available in this view.'
          : 'The issue log stopped updating. Reload the page to reconnect.';
        render();
      }
    );
  });
})();
`;

function renderPage(skills, teams, standards, hosted) {
  const agents = teams.flatMap((t) => t.agents);
  const agentByName = new Map(agents.map((a) => [a.name, a]));
  const agentByTeammate = new Map(agents.map((a) => [a.teammate, a]));
  const lead = teams.find((t) => t.readme);
  const steps = lead ? stripFences(sectionOf(lead.readme, 'Workflow the lead runs')).trim() : '';
  const gates = lead ? sectionOf(lead.readme, 'Gates and caps') : '';

  const issues = renderIssues(skills, hosted);
  const doc = (id, title, path, md) => docTemplate(id, title, path, renderMarkdown(md), hosted);
  const templates = [
    ...skills.map((s) => doc(s.id, `/${s.name}`, s.path, s.body)),
    ...agents.map((a) => doc(a.id, a.title, a.path, a.body)),
    ...standards.map((s) => doc(s.id, s.title, s.path, s.body)),
    ...teams.filter((t) => t.readme).map((t) => doc(t.id, t.title, t.readmePath, t.readme.replace(/^#\s+.+\n/, ''))),
  ];

  const section = (id, title, count, leadText, content, action = '') => `<section class="section" id="${id}" data-section>
<div class="container">
<div class="section__header">
<h2 class="section__title">${title}</h2>
<span class="section__count" data-count>${count}</span>
${action}
</div>
<p class="section__lead">${leadText}</p>
${content}
</div>
</section>`;

  const body = `<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
<div class="container site-header__inner">
<a class="site-header__brand" href="#top">UIUX AI Toolkit</a>
<nav class="site-nav" aria-label="Sections">
<ul class="site-nav__list">
<li><a class="site-nav__link" href="#workflow">Workflow</a></li>
<li><a class="site-nav__link" href="#skills">Skills</a></li>
<li><a class="site-nav__link" href="#agents">Agents</a></li>
<li><a class="site-nav__link" href="#standards">Standards</a></li>${
    issues ? '\n<li><a class="site-nav__link" href="#issues">Issues</a></li>' : ''
  }
</ul>
</nav>
<form class="search" role="search">
<label class="visually-hidden" for="catalog-search">Filter skills, agents, and standards</label>
<input class="search__input" id="catalog-search" type="search" placeholder="Filter by name or content" autocomplete="off">
<kbd class="search__key" aria-hidden="true">/</kbd>
</form>
</div>
</header>

<main id="main">
<p class="visually-hidden" id="catalog-status" role="status" aria-live="polite"></p>

<section class="hero" data-overview>
<div class="container">
<h1 class="hero__title">Agents and skills</h1>
<p class="hero__lead">What Claude Code loads from <code>.claude/</code> in this repository: the commands you run, the agent team they lead, and the standards the team builds and reviews against.</p>
<ul class="stats">
<li><a class="stats__item" href="#skills"><span class="stats__value">${skills.length}</span> <span class="stats__label">${skills.length === 1 ? 'skill' : 'skills'}</span></a></li>
<li><a class="stats__item" href="#agents"><span class="stats__value">${agents.length}</span> <span class="stats__label">${agents.length === 1 ? 'agent' : 'agents'}</span></a></li>
<li><a class="stats__item" href="#standards"><span class="stats__value">${standards.length}</span> <span class="stats__label">${standards.length === 1 ? 'standard' : 'standards'}</span></a></li>
</ul>
</div>
</section>

<section class="section" id="workflow" data-overview>
<div class="container">
<div class="section__header">
<h2 class="section__title">How a run flows</h2>
</div>
<p class="section__lead">Your session is the team lead. It spawns the teammates, merges their findings, and decides the two gates. It never analyzes, builds, validates, or reviews anything itself.</p>
${renderFlow(agentByName)}
${
  steps || gates
    ? `<div class="notes">
${steps ? `<div class="notes__panel"><h3 class="notes__title">Steps</h3><div class="prose prose--compact">${renderMarkdown(steps)}</div></div>` : ''}
${gates ? `<div class="notes__panel"><h3 class="notes__title">Gates and caps</h3><div class="prose prose--compact">${renderMarkdown(gates)}</div></div>` : ''}
</div>`
    : ''
}
</div>
</section>

${section(
  'skills',
  'Skills',
  skills.length,
  'The commands you type in Claude Code. Each one turns the session into the team lead and follows its playbook.',
  `<div class="cards">\n${skills.map((s) => renderSkill(s, teams, hosted)).join('\n')}\n</div>`,
)}

${section(
  'agents',
  'Agents',
  agents.length,
  'The teammates a skill spawns. Each has one job, a fixed set of files it may edit, and a fixed list of teammates it may message.',
  teams
    .map(
      (team) =>
        `<div class="cards" aria-label="${esc(team.title)}">\n${team.agents.map((a) => renderAgent(a, agentByTeammate)).join('\n')}\n</div>`,
    )
    .join('\n'),
  lead ? `<span class="section__action">${readButton(lead.id, 'Read the team README')}</span>` : '',
)}

${section(
  'standards',
  'Standards',
  standards.length,
  'The rules the team builds to and reviews against. Edit these to change what the agents produce.',
  `<div class="cards">\n${standards.map(renderStandard).join('\n')}\n</div>`,
)}

${issues}

<p class="empty container" id="catalog-empty" hidden>Nothing matches that filter.</p>
</main>

<footer class="site-footer">
<div class="container">
<p>Generated from <code>.claude/</code> by <code>scripts/build-catalog.mjs</code>. After editing an agent, a skill, or a standard, run <code>node scripts/build-catalog.mjs</code> to rebuild this page.${
    hosted ? ' This hosted copy changes when <code>docs/catalog.hosted.html</code> is published again.' : ''
  }</p>
</div>
</footer>

<dialog class="reader" id="reader" aria-labelledby="reader-title">
<header class="reader__header">
<div class="reader__heading">
<h2 class="reader__title" id="reader-title"></h2>
<a class="reader__path" id="reader-path" href="#"></a>
</div>
<button type="button" class="button" data-close>Close</button>
</header>
<div class="reader__body prose" id="reader-body" tabindex="0" autofocus></div>
</dialog>

${templates.join('\n')}

<script>${JS}</script>${hosted ? `\n<script>${ISSUES_JS}</script>` : ''}`;

  const generated = '<!-- Generated by scripts/build-catalog.mjs from .claude/. Do not edit by hand. -->';
  // claude.ai wraps a published page in its own document, so the hosted copy is the page
  // content alone, starting with its title and styles.
  if (hosted) {
    return `<title>UIUX AI Toolkit Catalog</title>
<meta name="claude:viewport-fit-sides" content="cover">
${generated}
<style>${CSS}</style>
${body}
`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agents and skills catalog</title>
<meta name="description" content="The skills, agents, and standards under .claude/ in this repository.">
${generated}
<style>${CSS}</style>
</head>
<body id="top">
${body}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------

const skills = loadSkills();
const teams = loadTeams(skills);
const agents = teams.flatMap((t) => t.agents);
const standards = loadStandards(agents, skills);

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, renderPage(skills, teams, standards, false));
writeFileSync(HOSTED_FILE, renderPage(skills, teams, standards, true));
console.log(
  `Wrote ${rel(OUT_FILE)} and ${rel(HOSTED_FILE)}: ${plural(skills.length, 'skill')}, ${plural(agents.length, 'agent')}, ${plural(standards.length, 'standard')}.`,
);

// Tune check tab: loads one or two .terx files and shows what differs.

import { parseTerx, checkTune, compareTunes, SECTION_LABELS, FIELDS, fieldText } from './terx.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slots = { good: null, check: null };

async function loadInto(which, file) {
  try {
    const buf = await file.arrayBuffer();
    slots[which] = parseTerx(buf, file.name);
    $(which + 'Name').textContent = file.name;
    $(which + 'Name').classList.remove('muted');
    $('tuneMsg').textContent = '';
    render();
  } catch (e) {
    $('tuneMsg').textContent = e.message;
    $('tuneMsg').className = 'msg err';
  }
}

export function isTuneFile(file) {
  return /\.terx$/i.test(file.name);
}

export function loadTuneToCheck(file) {
  return loadInto('check', file);
}

function warningList(ws) {
  if (!ws.length) return '';
  return `<ul class="warnings">${ws.map((w) => `<li class="${w.level}"><b>${esc(w.title)}</b><p>${esc(w.detail)}</p></li>`).join('')}</ul>`;
}

function verdict(ws, compared) {
  const bad = ws.filter((w) => w.level === 'bad').length;
  const warn = ws.filter((w) => w.level === 'warn').length;
  if (bad) return `<div class="verdict bad">Do not load this tune yet: ${bad} serious problem${bad > 1 ? 's' : ''} found<span>Fix the red items in Holley EFI software first, or go back to the known good tune.</span></div>`;
  if (warn) return `<div class="verdict warn">${warn} thing${warn > 1 ? 's' : ''} to check before loading<span>None of these stop the car on their own, but confirm each one.</span></div>`;
  return `<div class="verdict ok">No problems found<span>${compared ? 'Key settings match the known good tune.' : 'Add a known good tune to compare settings too.'}</span></div>`;
}

function fileDetails(t, label) {
  const bases = t.bases.filter((b) => !b.cleared).map((b) => `${SECTION_LABELS[b.kind] || b.kind}: ${esc(b.name)}`).join('<br>');
  return `<tr><th>${label}</th><td>${esc(t.fileName)}<br><span class="muted">Saved name: ${esc(t.name)}<br>${t.size.toLocaleString()} bytes, checksum ${t.checksumOk ? 'OK' : '<b style="color:var(--bad)">BAD</b>'}<br>${esc(t.wizard || 'No wizard text')}</span></td><td class="note">${bases}</td></tr>`;
}

function render() {
  const host = $('tuneResults');
  const { good, check } = slots;
  if (!check) {
    host.innerHTML = `<div class="grid-wrap empty">${good ? 'Now choose the tune to check.' : 'Choose a tune to check. Drop .terx files on the boxes on the left, or use Choose file.'}</div>`;
    return;
  }
  if (!good) {
    const ws = checkTune(check);
    const rows = FIELDS.map((f) => `<tr><th>${f.label}</th><td>${esc(fieldText(f.key, check.fields[f.key]))}</td><td class="note">${esc(f.note)}</td></tr>`).join('');
    host.innerHTML = `${verdict(ws, false)}${warningList(ws)}
      <h3>Key settings</h3><div class="tbl-wrap"><table class="kv"><tbody>${rows}</tbody></table></div>
      <h3>Sections</h3><p class="muted" style="font-size:13px">${check.sections.map((s) => SECTION_LABELS[s.kind] || s.kind).join(', ')}</p>
      <h3>File</h3><div class="tbl-wrap"><table class="kv"><tbody>${fileDetails(check, 'Tune to check')}</tbody></table></div>`;
    return;
  }
  const r = compareTunes(good, check);
  const rows = r.rows
    .map((x) => `<tr><th>${esc(x.label)}</th><td>${esc(x.good)}</td><td class="${x.same ? '' : 'diff'}">${esc(x.check)}</td><td class="note">${esc(x.note)}</td></tr>`)
    .join('');
  const secs = r.sections
    .map((s) => {
      const state = !s.inCheck ? '<td class="diff">Missing</td>' : !s.inGood ? '<td class="diff">Added</td>' : `<td>${s.pct.toFixed(0)}% <span class="muted">(${s.diff.toLocaleString()} of ${s.total.toLocaleString()} values)</span></td>`;
      const bar = s.pct != null ? `<div class="bar"><i style="width:${Math.min(100, s.pct).toFixed(0)}%"></i></div>` : '';
      return `<tr><th>${esc(s.label)}</th>${state}<td>${bar}</td></tr>`;
    })
    .join('');
  host.innerHTML = `${verdict(r.warnings, true)}${warningList(r.warnings)}
    <h3>Key settings</h3>
    <div class="tbl-wrap"><table class="kv"><thead><tr><th>Setting</th><th>Known good</th><th>To check</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h3>How much each section changed</h3>
    <div class="tbl-wrap"><table class="kv"><thead><tr><th>Section</th><th>Values different</th><th></th></tr></thead><tbody>${secs}</tbody></table></div>
    <h3>Files</h3>
    <div class="tbl-wrap"><table class="kv"><tbody>${fileDetails(good, 'Known good')}${fileDetails(check, 'To check')}</tbody></table></div>`;
}

export function initTuneCheck() {
  $('goodFile').addEventListener('change', (e) => e.target.files[0] && loadInto('good', e.target.files[0]).then(() => (e.target.value = '')));
  $('checkFile').addEventListener('change', (e) => e.target.files[0] && loadInto('check', e.target.files[0]).then(() => (e.target.value = '')));
  for (const [id, which] of [['dropGood', 'good'], ['dropCheck', 'check']]) {
    const el = $(id);
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('over');
      const files = [...e.dataTransfer.files];
      if (files[0]) loadInto(which, files[0]);
      if (files[1] && which === 'good') loadInto('check', files[1]);
    });
  }
  $('tuneSwap').addEventListener('click', () => {
    [slots.good, slots.check] = [slots.check, slots.good];
    for (const w of ['good', 'check']) {
      $(w + 'Name').textContent = slots[w] ? slots[w].fileName : 'None loaded';
      $(w + 'Name').classList.toggle('muted', !slots[w]);
    }
    render();
  });
}

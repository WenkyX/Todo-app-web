const DB_NAME = 'kanban_db';
const DB_VERSION = 1;
const STORE_NAME = 'state';
const STATE_KEY = 'main';

let db = null;
let state = null;
let editingCardId = null;
let activeCat = null;
let dragCard = null;
let hoursPromptCallback = null;
let autoScrollRAF = null;
let autoScrollTarget = null;
let autoScrollDir = 0;

const DEFAULT_STATE = {
  name: '',
  exportLookback: 1,
  categories: [
    {name:'Personal', is_daily:false}, 
    {name:'Work',     is_daily:true}, 
  ],
  stages: [
    {name:'Planning',      is_start:false, is_done:false},
    {name:'In Progress',  is_start:true,  is_done:false},
    {name:'On Hold',       is_start:false, is_done:false},
    {name:'Done',         is_start:false, is_done:true}
  ],
  cards: []
};

// ── IndexedDB ────────────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror  = e => reject(e.target.error);
  });
}

function dbGet(key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror  = e => reject(e.target.error);
  });
}

function dbPut(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror  = e => reject(e.target.error);
  });
}

async function save() {
  await dbPut(STATE_KEY, state);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function localISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function localDate() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}

function getActiveCat() {
  if (!activeCat || !state.categories.includes(activeCat)) {
    activeCat = state.categories[0] || null;
  }
  return activeCat;
}


// ── Hours prompt ─────────────────────────────────────────────────────────────

function promptHours(cardTitle, callback) {
  document.getElementById('hoursPromptTitle').textContent = '"' + cardTitle + '"';
  document.getElementById('hoursPromptInput').value = '';
  hoursPromptCallback = callback;
  document.getElementById('hoursPromptOverlay').classList.add('open');
  setTimeout(() => document.getElementById('hoursPromptInput').focus(), 50);
}

function hoursPromptConfirm() {
  const val = document.getElementById('hoursPromptInput').value;
  document.getElementById('hoursPromptOverlay').classList.remove('open');
  if (hoursPromptCallback) hoursPromptCallback(val || null);
  hoursPromptCallback = null;
}

function hoursPromptSkip() {
  document.getElementById('hoursPromptOverlay').classList.remove('open');
  if (hoursPromptCallback) hoursPromptCallback(null);
  hoursPromptCallback = null;
}


function applyDragMove(card, newStage, newCat, stageObj, afterApply) {
  // afterApply is called after state mutation (and optional hours prompt) → save+render
  const prevStage = card.stage;
  const prevCat   = card.category;
  const isCross   = prevStage !== newStage || prevCat !== newCat;
  card.stage    = newStage;
  card.category = newCat;
  const now = localISO();
  if (prevStage !== newStage) {
    if (stageObj.is_start) card.startDate = now;
    if (stageObj.is_done)  card.doneDate  = now;
  }
  if (isCross) reseq(prevCat, prevStage);

  if (stageObj.is_done && prevStage !== newStage) {
    promptHours(card.title || 'Untitled', hours => {
      if (hours !== null) card.hours = hours;
      afterApply();
    });
  } else {
    afterApply();
  }
}


// ── Auto-scroll ───────────────────────────────────────────────────────────────

function startAutoScroll(el, dir) {
  if (autoScrollTarget === el && autoScrollDir === dir) return;
  stopAutoScroll();
  autoScrollTarget = el;
  autoScrollDir = dir;
  const tick = () => {
    if (!autoScrollTarget) return;
    autoScrollTarget.scrollTop += autoScrollDir * 8;
    autoScrollRAF = requestAnimationFrame(tick);
  };
  autoScrollRAF = requestAnimationFrame(tick);
}

function stopAutoScroll() {
  if (autoScrollRAF) cancelAnimationFrame(autoScrollRAF);
  autoScrollRAF = null;
  autoScrollTarget = null;
  autoScrollDir = 0;
}

// ── Sequence helpers ─────────────────────────────────────────────────────────

function nextSeq(category, stage) {
  const bucket = state.cards.filter(c => c.category === category && c.stage === stage);
  return bucket.length ? Math.max(...bucket.map(c => c.seq || 0)) + 1 : 1;
}

function reseq(category, stage) {
  // Re-assign sequential integers 1,2,3… to cards in a bucket, preserving current order
  const bucket = state.cards
    .filter(c => c.category === category && c.stage === stage)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  bucket.forEach((card, i) => { card.seq = i + 1; });
}

// ── Render ───────────────────────────────────────────────────────────────────

function render() {
  renderCatBar();
  renderBoard();
}

function renderCatBar() {
  const bar = document.getElementById('catBar');
  bar.innerHTML = '';
  const cat = getActiveCat();
  state.categories.forEach(c => {
    const t = document.createElement('button');
    t.className = 'cat-tab' + (c === cat ? ' active' : '');
    t.textContent = c.name;
    t.onclick = () => { activeCat = c; render(); };
    bar.appendChild(t);
  });
}

function renderBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  const cat = getActiveCat().name;

  if (!cat) {
    board.innerHTML = '<div class="empty-board"><p style="font-size:15px;font-weight:500;color:#888">No categories</p><p>Click Manage to add one.</p></div>';
    return;
  }

  state.stages.forEach(stageObj => {
    const stage = stageObj.name;
    // Sort cards by seq for this bucket
    const cards = state.cards
      .filter(c => c.category === cat && c.stage === stage)
      .sort((a, b) => (a.seq || 0) - (b.seq || 0));

    const col = document.createElement('div');
    col.className = 'col';
    col.dataset.stage = stage;

    // ── Column-level dragover/dragleave/drop (cross-column, drop on empty space) ──
    col.addEventListener('dragover', e => {
      e.preventDefault();
      // Only activate col highlight when dragging over header/empty area outside cardList
      if (!cardList.contains(e.target)) {
        col.classList.add('drag-over');
      }
    });
    col.addEventListener('dragleave', e => {
      if (!col.contains(e.relatedTarget)) {
        col.classList.remove('drag-over');
        clearIndicators(col);
        stopAutoScroll();
      }
    });
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      clearIndicators(col);
      stopAutoScroll();
      // Only handle drops that land on col itself (empty col / header area)
      // cardList handles all drops when there are cards
      if (!dragCard || e.target.closest('.cards')) return;
      const card = dragCard;
      const prevStage = card.stage;
      const prevCat   = card.category;
      if (prevStage !== stage || prevCat !== cat) {
        card.seq = nextSeq(cat, stage);
        applyDragMove(card, stage, cat, stageObj, () => save().then(render));
      } else {
        card.seq = nextSeq(cat, stage) + 1;
        reseq(cat.name, stage);
        save().then(render);
      }
    });

    // ── Header ──────────────────────────────────────────────────────────────
    const hdr = document.createElement('div');
    hdr.className = 'col-header';

    const title = document.createElement('div');
    title.className = 'col-title';
    title.contentEditable = true;
    title.textContent = stage;
    title.spellcheck = false;
    title.addEventListener('blur', () => {
      const nv = title.textContent.trim();
      if (nv && nv !== stage) {
        const idx = state.stages.findIndex(s => s.name === stage);
        if (idx > -1) {
          state.cards.forEach(c => { if (c.stage === stage) c.stage = nv; });
          state.stages[idx].name = nv;
          save().then(render);
        }
      } else if (!nv) {
        title.textContent = stage;
      }
    });
    title.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    });

    const count = document.createElement('span');
    count.className = 'col-count';
    count.textContent = cards.length;

    const addBtn = document.createElement('button');
    addBtn.className = 'add-card-btn';
    addBtn.textContent = '+ Add';
    addBtn.onclick = () => openNewCard(stage);

    const del = document.createElement('button');
    del.className = 'col-del';
    del.innerHTML = '&#10005;';
    del.title = 'Delete stage';
    del.onclick = () => {
      const hasCards = state.cards.some(c => c.stage === stage);
      if (hasCards) {
        if (!confirm('Delete stage "' + stage + '"? Tasks in it will be moved to the first remaining stage.')) return;
        const fallback = state.stages.find(s => s.name !== stage);
        state.cards.forEach(c => { if (c.stage === stage) c.stage = fallback ? fallback.name : ''; });
      }
      state.stages = state.stages.filter(s => s.name !== stage);
      save().then(render);
    };

    hdr.appendChild(title);
    hdr.appendChild(count);
    hdr.appendChild(addBtn);
    hdr.appendChild(del);
    col.appendChild(hdr);

    // ── Card list ────────────────────────────────────────────────────────────
    const cardList = document.createElement('div');
    cardList.className = 'cards';

    // Leading indicator (before first card)
    cardList.appendChild(makeIndicator(cat, stage, null, stageObj));

    cards.forEach(card => {
      const el = document.createElement('div');
      el.className = 'card';
      el.draggable = true;
      el.dataset.cardId = card.id;

      el.addEventListener('dragstart', e => {
        dragCard = card;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => {
          el.classList.add('dragging');
          // Mark ALL cardLists so pointer-events pass through cards
          document.querySelectorAll('.cards').forEach(cl => cl.classList.add('is-dragging'));
        }, 0);
      });
      el.addEventListener('dragend', () => {
        dragCard = null;
        el.classList.remove('dragging');
        document.querySelectorAll('.cards').forEach(cl => cl.classList.remove('is-dragging'));
        clearIndicators(col);
        col.classList.remove('drag-over');
        stopAutoScroll();
      });





      const t = document.createElement('div');
      t.className = 'card-title';
      t.textContent = card.title || 'Untitled';
      el.appendChild(t);

      if (card.description) {
        const dp = document.createElement('div');
        dp.className = 'card-desc-preview';
        dp.textContent = card.description;
        el.appendChild(dp);
      }

      const meta = document.createElement('div');
      meta.className = 'card-meta';
      if (card.date) {
        const ds = document.createElement('span');
        ds.textContent = '📅 ' + card.date;
        meta.appendChild(ds);
      }
      if (card.hours) {
        const hs = document.createElement('span');
        hs.textContent = '⏱ ' + card.hours + 'h';
        meta.appendChild(hs);
      }
      if (card.dueDate) {
        const dd = document.createElement('span');
        dd.className = 'due-date';
        const due = new Date(card.dueDate);
        const now = new Date();
        if (stageObj.is_done) {
          dd.classList.add('done');
        } else if (due < now) {
          dd.classList.add('overdue');
        } else if (due - now <= 24 * 60 * 60 * 1000) {
          dd.classList.add('soon');
        }
        const pad = n => String(n).padStart(2,'0');
        const fmt = due.getFullYear() + '-' + pad(due.getMonth()+1) + '-' + pad(due.getDate()) +
                    ' ' + pad(due.getHours()) + ':' + pad(due.getMinutes());
        dd.textContent = '⏰ ' + fmt;
        meta.appendChild(dd);
      }
      if (meta.children.length) el.appendChild(meta);

      el.onclick = () => openEditCard(card.id);
      cardList.appendChild(el);

      // Indicator after each card
      cardList.appendChild(makeIndicator(cat, stage, card, stageObj));
    });

    // ── cardList-level dragover: handles indicator + auto-scroll ───────────────
    cardList.addEventListener('dragover', e => {
      e.preventDefault();
      col.classList.remove('drag-over');

      // Auto-scroll near edges
      const listRect = cardList.getBoundingClientRect();
      const EDGE = 48;
      if (e.clientY < listRect.top + EDGE) {
        startAutoScroll(cardList, -1);
      } else if (e.clientY > listRect.bottom - EDGE) {
        startAutoScroll(cardList, 1);
      } else {
        stopAutoScroll();
      }

      // Find which indicator to activate based on cursor position
      clearIndicators(col);
      const indicators = Array.from(cardList.querySelectorAll('.card-drop-indicator'));
      const cards = Array.from(cardList.querySelectorAll('.card'));

      if (cards.length === 0) {
        if (indicators[0]) indicators[0].classList.add('active');
        return;
      }

      // Find the card the cursor is over or between
      let placed = false;
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        const mid  = rect.top + rect.height / 2;
        if (e.clientY <= mid) {
          // Before card i → indicator i (there's one indicator before each card)
          if (indicators[i]) indicators[i].classList.add('active');
          placed = true;
          break;
        }
      }
      if (!placed) {
        // After last card
        if (indicators[indicators.length - 1]) indicators[indicators.length - 1].classList.add('active');
      }
    });

    cardList.addEventListener('dragleave', e => {
      if (!cardList.contains(e.relatedTarget)) {
        stopAutoScroll();
        clearIndicators(col);
      }
    });

    cardList.addEventListener('drop', e => {
      e.preventDefault();
      document.querySelectorAll('.cards').forEach(cl => cl.classList.remove('is-dragging'));
      col.classList.remove('drag-over');
      stopAutoScroll();
      if (!dragCard) return;

      // Find the active indicator to determine insertion point
      const indicators = Array.from(cardList.querySelectorAll('.card-drop-indicator'));
      const activeIdx = indicators.findIndex(ind => ind.classList.contains('active'));
      clearIndicators(col);

      const moving = dragCard;
      const prevStage = moving.stage;
      const prevCat   = moving.category;

      const doReorder = () => {
        // Build sorted bucket without the moving card
        let bucket = state.cards
          .filter(card => card.category === cat && card.stage === stage && card.id !== moving.id)
          .sort((a, b) => (a.seq || 0) - (b.seq || 0));

        // indicators[0] = before card 0, indicators[1] = after card 0 / before card 1, etc.
        // activeIdx directly maps to the insertion index in the bucket
        const insertIdx = activeIdx < 0 ? bucket.length : Math.min(activeIdx, bucket.length);
        bucket.splice(insertIdx, 0, moving);
        bucket.forEach((card, i) => { card.seq = i + 1; });
        save().then(render);
      };

      if (prevStage !== stage || prevCat !== cat) {
        applyDragMove(moving, stage, cat, stageObj, doReorder);
      } else {
        doReorder();
      }
    });

    col.appendChild(cardList);
    board.appendChild(col);
  });

  const addCol = document.createElement('button');
  addCol.className = 'add-col-btn';
  addCol.textContent = '+ Add stage';
  addCol.onclick = addStageInline;
  board.appendChild(addCol);
}

function makeIndicator(cat, stage, afterCard, stageObj) {
  const ind = document.createElement('div');
  ind.className = 'card-drop-indicator';
  ind.addEventListener('dragover', e => { e.preventDefault(); });

  return ind;
}

function clearIndicators(col) {
  col.querySelectorAll('.card-drop-indicator').forEach(el => el.classList.remove('active'));
}

// ── Card modal ───────────────────────────────────────────────────────────────

function openNewCard(stage) {
  editingCardId = null;
  document.getElementById('modalTitle').textContent = 'New task';
  document.getElementById('fTitle').value = '';
  document.getElementById('fDesc').value = '';
  document.getElementById('fDate').value = '';
  document.getElementById('fHours').value = '';
  document.getElementById('fStartDate').value = '';
  document.getElementById('fDoneDate').value = '';
  document.getElementById('fDueDate').value = '';
  document.getElementById('deleteBtn').style.display = 'none';
  populateCardSelects(getActiveCat().name, stage || (state.stages[0] ? state.stages[0].name : ''));
  document.getElementById('cardOverlay').classList.add('open');
  setTimeout(() => document.getElementById('fTitle').focus(), 50);
}

function openEditCard(id) {
  const card = state.cards.find(c => c.id === id);
  if (!card) return;
  editingCardId = id;
  document.getElementById('modalTitle').textContent = 'Edit task';
  document.getElementById('fTitle').value = card.title || '';
  document.getElementById('fDesc').value = card.description || '';
  document.getElementById('fDate').value = card.date || '';
  document.getElementById('fHours').value = card.hours || '';
  document.getElementById('fStartDate').value = card.startDate ? card.startDate.slice(0,16) : '';
  document.getElementById('fDoneDate').value = card.doneDate ? card.doneDate.slice(0,16) : '';
  document.getElementById('fDueDate').value = card.dueDate ? card.dueDate.slice(0,16) : '';
  document.getElementById('deleteBtn').style.display = 'inline-block';
  populateCardSelects(card.category, card.stage);
  document.getElementById('cardOverlay').classList.add('open');
}

function populateCardSelects(cat, stage) {
  const catSel = document.getElementById('fCat');
  catSel.innerHTML = '';
  state.categories.forEach(c => {
    const o = document.createElement('option');
    o.value = c.name; o.textContent = c.name;
    if (c.name === cat) o.selected = true;
    catSel.appendChild(o);
  });
  const stageSel = document.getElementById('fStage');
  stageSel.innerHTML = '';
  state.stages.forEach(s => {
    const o = document.createElement('option');
    o.value = s.name; o.textContent = s.name;
    if (s.name === stage) o.selected = true;
    stageSel.appendChild(o);
  });
}

async function saveCard() {
  const title = document.getElementById('fTitle').value.trim();
  if (!title) { document.getElementById('fTitle').focus(); return; }
  const newStage = document.getElementById('fStage').value;
  const stageObj = state.stages.find(s => s.name === newStage) || {};
  const data = {
    title,
    description: document.getElementById('fDesc').value.trim(),
    category: document.getElementById('fCat').value,
    stage: newStage,
    date: document.getElementById('fDate').value,
    hours: document.getElementById('fHours').value,
    startDate: document.getElementById('fStartDate').value || '',
    doneDate: document.getElementById('fDoneDate').value || '',
    dueDate: document.getElementById('fDueDate').value || ''
  };
  if (editingCardId) {
    const idx = state.cards.findIndex(c => c.id === editingCardId);
    if (idx > -1) {
      const prev = state.cards[idx];
      if (prev.stage !== newStage || prev.category !== data.category) {
        const now = localISO();
        if (stageObj.is_start && !data.startDate) data.startDate = now;
        if (stageObj.is_done && !data.doneDate) data.doneDate = now;
        data.seq = nextSeq(data.category, newStage);
        state.cards[idx] = { ...prev, ...data };
        reseq(prev.category, prev.stage);
        closeCard();
        if (stageObj.is_done && prev.stage !== newStage) {
          promptHours(data.title, hours => {
            if (hours !== null) state.cards[idx].hours = hours;
            save().then(render);
          });
        } else {
          await save();
          render();
        }
        return;
      } else {
        state.cards[idx] = { ...prev, ...data };
      }
    }
  } else {
    const now = localISO();
    if (stageObj.is_start && !data.startDate) data.startDate = now;
    if (stageObj.is_done && !data.doneDate) data.doneDate = now;
    data.seq = nextSeq(data.category, data.stage);
    state.cards.push({ id: uid(), createdAt: now, ...data });
    if (stageObj.is_done) {
      const newCard = state.cards[state.cards.length - 1];
      closeCard();
      promptHours(data.title, hours => {
        if (hours !== null) newCard.hours = hours;
        save().then(render);
      });
      return;
    }
  }
  await save();
  closeCard();
  render();
}

async function deleteCard() {
  if (!editingCardId) return;
  if (!confirm('Delete this task?')) return;
  state.cards = state.cards.filter(c => c.id !== editingCardId);
  await save();
  closeCard();
  render();
}

function closeCard() {
  document.getElementById('cardOverlay').classList.remove('open');
  editingCardId = null;
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function openSettings() {
  renderSettingsPanel();
  document.getElementById('settingsOverlay').classList.add('open');
  await renderStorageInfo();
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('open');
}

function overlayClick(e, id, closeFn) {
  if (e.target === document.getElementById(id)) closeFn();
}

async function renderStorageInfo() {
  const el = document.getElementById('storageInfo');
  if (!el) return;
  try {
    if (!navigator.storage || !navigator.storage.estimate) {
      el.innerHTML = '<span style="color:var(--text3)">Storage API not available in this browser.</span>';
      return;
    }
    const { usage, quota } = await navigator.storage.estimate();
    const fmt = b => {
      if (b === undefined || b === null) return 'N/A';
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
      if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
      return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    };
    const pct = quota ? ((usage / quota) * 100).toFixed(2) : null;
    const barWidth = pct ? Math.min(100, parseFloat(pct)) : 0;
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between">
        <span>Used</span><span style="color:var(--text);font-weight:500">${fmt(usage)}</span>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span>Quota</span><span style="color:var(--text);font-weight:500">${fmt(quota)}</span>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span>Usage</span><span style="color:var(--text);font-weight:500">${pct !== null ? pct + '%' : 'N/A'}</span>
      </div>
      <div style="background:var(--border);border-radius:4px;height:6px;margin-top:2px;overflow:hidden">
        <div style="background:var(--accent);height:100%;width:${barWidth}%;border-radius:4px;transition:width 0.3s"></div>
      </div>
    `;
  } catch(err) {
    el.innerHTML = '<span style="color:var(--text3)">Could not read storage info: ' + err.message + '</span>';
  }
}

function renderSettingsPanel() {
  document.getElementById('settingsName').value = state.name || '';
  document.getElementById('settingsLookback').value = state.exportLookback !== undefined ? state.exportLookback : 1;
  const cl = document.getElementById('catList');
  cl.innerHTML = '';

  const makeToggle = (label, field, item, index) => {
    const lbl = document.createElement('label');
    lbl.className = 'pill-toggle ' + field;
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !!item[field];
    chk.dataset.field = field;
    chk.dataset.idx = index;
    const track = document.createElement('span');
    track.className = 'pill-track';
    lbl.appendChild(chk);
    lbl.appendChild(track);
    lbl.appendChild(document.createTextNode(label));
    return lbl;
  };

  state.categories.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'list-item';
    const inp = document.createElement('input');
    inp.value = c.name;
    inp.dataset.idx = i;
    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.style.cssText = 'font-size:11px;padding:2px 8px;flex-shrink:0';
    del.textContent = 'Remove';
    del.onclick = () => {
      if (state.cards.some(card => card.category === c.name)) {
        if (!confirm('Remove category "' + c.name + '"? All tasks in it will be deleted.')) return;
        state.cards = state.cards.filter(card => card.category !== c.name);
      }
      state.categories.splice(i, 1);
      if (activeCat === c) activeCat = state.categories[0] || null;
      save().then(renderSettingsPanel);
    };
    row.appendChild(inp);
    row.appendChild(makeToggle('Daily', 'is_daily', c, i));
    row.appendChild(del);
    cl.appendChild(row);
  });

  const sl = document.getElementById('stageList');
  sl.innerHTML = '';
  state.stages.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.style.flexWrap = 'wrap';
    row.style.gap = '6px';

    const inp = document.createElement('input');
    inp.value = s.name;
    inp.dataset.idx = i;
    inp.style.minWidth = '100px';

    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.style.cssText = 'font-size:11px;padding:2px 8px;flex-shrink:0';
    del.textContent = 'Remove';
    del.onclick = () => {
      if (state.cards.some(card => card.stage === s.name)) {
        if (!confirm('Remove stage "' + s.name + '"? Tasks in it will be moved to the first remaining stage.')) return;
        const fallback = state.stages.find(st => st.name !== s.name);
        state.cards.forEach(card => { if (card.stage === s.name) card.stage = fallback ? fallback.name : ''; });
      }
      state.stages.splice(i, 1);
      save().then(renderSettingsPanel);
    };

    row.appendChild(inp);
    row.appendChild(makeToggle('Start', 'is_start', s, i));
    row.appendChild(makeToggle('Done', 'is_done', s, i));
    row.appendChild(del);
    sl.appendChild(row);
  });
}

function addCategory() {
  state.categories.push({name:'New Category', is_daily:true});
  save().then(renderSettingsPanel);
  setTimeout(() => {
    const inputs = document.querySelectorAll('#catList input');
    const last = inputs[inputs.length - 1];
    if (last) { last.focus(); last.select(); }
  }, 0);
}

function addStage() {
  state.stages.push({name:'New Stage', is_start:false, is_done:false});
  save().then(renderSettingsPanel);
  setTimeout(() => {
    const inputs = document.querySelectorAll('#stageList input:not([type="checkbox"])');
    const last = inputs[inputs.length - 1];
    if (last) { last.focus(); last.select(); }
  }, 0);
}

function addStageInline() {
  const name = prompt('Stage name:');
  if (!name || !name.trim()) return;
  state.stages.push({name: name.trim(), is_start:false, is_done:false});
  save().then(render);
}

async function saveSettings() {
  state.name = document.getElementById('settingsName').value.trim();
  state.exportLookback = Math.max(1, parseInt(document.getElementById('settingsLookback').value) || 1);

  const catRows = document.querySelectorAll('#catList .list-item');
  const newCats = [];
  catRows.forEach((row, i) => {
    const inp = row.querySelector('input:not([type="checkbox"])');
    const nv = inp ? inp.value.trim() : '';
    const old = state.categories[i];
    if (nv && old && nv !== old.name) {
      state.cards.forEach(c => { if (c.category === old.name) c.category = nv; });
      if (activeCat === old) activeCat = nv;
    }
    const dailyChk = row.querySelector('input[data-field="is_daily"]');
    if (nv) newCats.push({
      name: nv,
      is_daily: dailyChk ? dailyChk.checked : false,
    });
  });
  state.categories = newCats;

  const stageRows = document.querySelectorAll('#stageList .list-item');
  const newStages = [];
  stageRows.forEach((row, i) => {
    const inp = row.querySelector('input:not([type="checkbox"])');
    const nv = inp ? inp.value.trim() : '';
    const old = state.stages[i];
    if (nv && old && nv !== old.name) {
      state.cards.forEach(c => { if (c.stage === old.name) c.stage = nv; });
    }
    const startChk = row.querySelector('input[data-field="is_start"]');
    const doneChk  = row.querySelector('input[data-field="is_done"]');
    if (nv) newStages.push({
      name: nv,
      is_start: startChk ? startChk.checked : false,
      is_done:  doneChk  ? doneChk.checked  : false
    });
  });
  state.stages = newStages;

  if (!state.categories.includes(activeCat)) activeCat = state.categories[0] || null;
  await save();
  closeSettings();
  render();
}

// ── Exports / Import ─────────────────────────────────────────────────────────

function openExportCSV() {
  document.getElementById('csvExportOverlay').classList.add('open');
}

function closeExportCSV() {
  document.getElementById('csvExportOverlay').classList.remove('open');
}

function exportCSV() {
  const dateFrom = document.getElementById('beginCsvExport').value;
  const dateTo = document.getElementById('endCsvExport').value;

  closeExportCSV();
  exportTaskCSV()
  
  const headers = ['id','confirmed_mandays','date','date_deadline','name','employee_id','is_manday_confirmed','mandays','overtime_mandays','is_overtime','project_id','unit_amount','requestor','task_id','task_stage_id','user_id'];
  const nameFiltering = document.getElementById('nameFiltering2').value.split('\n');

  const rows = state.cards
    .slice()
    .filter(c => {
      const done = c.doneDate ? c.doneDate.slice(0, 10) : null;
      if (dateFrom && done && done <= dateFrom) return false;
      if (dateTo && done && done >= dateTo) return false;
      if (nameFiltering.includes(c.title)) return false;
      if (c.stage != 'Done') return false;
      console.log(c)
      return true;
    })
    .sort((a, b) => {
      if (!a.doneDate && !b.doneDate) return 0;
      if (!a.doneDate) return 1;
      if (!b.doneDate) return -1;
      return a.doneDate.localeCompare(b.doneDate);
    })
    .map(c => [
      '',                  // id (leave blank, Odoo assigns on import)
      '0.0',               // confirmed_mandays
      c.doneDate ? c.doneDate.slice(0, 10) : '',        // date
      c.dueDate ? c.dueDate.slice(0, 10) : '',     // date_deadline
      c.description || '',       // name
      state.name || '',    // employee_id
      '',                  // is_manday_confirmed
      (c.hours / 8).toFixed(3) || '',       // mandays
      '0.0',               // overtime_mandays
      '',                  // is_overtime
      c.category || '',    // project_id
      '1.0',               // unit_amount
      '',                  // requestor
      c.title || '',       // task_id
      '',       // task_stage_id
      state.name || '',    // user_id
    ].map(v => '"' + String(v).replace(/"/g, '""') + '"'));

  const csv = [headers.map(h => '"' + h + '"').join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'timesheet_export_' + localDate() + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function exportTaskCSV() {
  const dateFrom = document.getElementById('beginCsvExport').value;
  const dateTo = document.getElementById('endCsvExport').value;
  const headers = ['id','activity_ids','user_ids','company_id','priority','project_id','recurrence_id','sale_line_id','sequence','stage_id','planned_date_begin','state','tag_ids','name'];
  const nameFiltering = document.getElementById('nameFiltering').value.split('\n');

  const rows = state.cards
    .slice()
    .filter(c => {
      const done = c.doneDate ? c.doneDate.slice(0, 10) : null;
      if (dateFrom && done && done <= dateFrom) return false;
      if (dateTo && done && done >= dateTo) return false;
      if (nameFiltering.includes(c.title)) return false;
      return true;
    })
    .sort((a, b) => {
      if (!a.doneDate && !b.doneDate) return 0;
      if (!a.doneDate) return 1;
      if (!b.doneDate) return -1;
      return a.doneDate.localeCompare(b.doneDate);
    })
    .map(c => [
      '',              // id
      '',              // activity_ids
      state.name || '', // user_ids
      '',              // company_id
      '',              // priority
      c.category || '', // project_id
      '',              // recurrence_id
      '',              // sale_line_id
      '',              // sequence
      '',   // stage_id
      '',              // planned_date_begin
      '',              // state
      '',              // tag_ids
      c.title || '',   // name
    ].map(v => '"' + String(v).replace(/"/g, '""') + '"'));

  const csv = [headers.map(h => '"' + h + '"').join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tasks_export_' + localDate() + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function openTextExport() {
  const now = new Date();
  const lookback = state.exportLookback !== undefined ? state.exportLookback : 1;
  const dayOffset = now.getDay() === 1 ? 3 : lookback;
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset, 0, 1, 0);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const formattedDate = now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();
  const nameStr = state.name ? state.name + ' ' : '';
  const lines = ['Daily ' + nameStr + formattedDate + ':'];
  state.categories.forEach(cat => {
    const catCards = state.cards.filter(c => c.category === cat.name);
    if (!catCards.length) return;
    if (!cat.is_daily) return;
    // lines.push('*' + cat.name + '*');
    let catName = ('*' + cat.name + '*');
    const tasks = [];
    state.stages.forEach(stageObj => {
      let stageCards = catCards.filter(c => c.stage === stageObj.name);
      if (stageObj.is_done) {
        stageCards = stageCards.filter(c => {
          if (!c.doneDate) return false;
          const d = new Date(c.doneDate);
          return d >= yesterdayStart && d <= now;
        });
      }
      if (!stageCards.length) return;
      tasks.push('*' + stageObj.name + '*');
      stageCards.forEach(c => tasks.push('- ' + (c.title || 'Untitled')));
    });
    if (tasks.length) {
      lines.push(catName);
      lines.push(...tasks);
    }
  });
  document.getElementById('textExportContent').value = lines.join('\n');
  document.getElementById('copyBtn').textContent = 'Copy to clipboard';
  document.getElementById('textExportOverlay').classList.add('open');
}

function closeTextExport() {
  document.getElementById('textExportOverlay').classList.remove('open');
}

function copyTextExport() {
  const text = document.getElementById('textExportContent').value;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy to clipboard', 2000);
  }).catch(() => {
    document.getElementById('textExportContent').select();
    document.execCommand('copy');
  });
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tasks_' + localDate() + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importJSONClick() {
  document.getElementById('importFile').value = '';
  document.getElementById('importFile').click();
}

function importJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const parsed = JSON.parse(ev.target.result);
      if (!parsed.categories || !parsed.stages || !parsed.cards) {
        alert('Invalid file: missing categories, stages, or cards.');
        return;
      }
      if (!confirm('This will replace all current data. Continue?')) return;
      state = parsed;
      activeCat = state.categories[0] || null;
      await save();
      render();
    } catch(err) {
      alert('Failed to parse JSON: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ── Init ─────────────────────────────────────────────────────────────────────


function toggleDark() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('kanban_theme', next);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('darkToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}

document.getElementById('hoursPromptInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') hoursPromptConfirm();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeCard(); closeSettings(); closeTextExport(); hoursPromptSkip(); closeExportCSV(); }
});

openDB().then(async database => {
  db = database;
  const stored = await dbGet(STATE_KEY);
  state = stored || JSON.parse(JSON.stringify(DEFAULT_STATE));
  activeCat = state.categories[0] || null;
  render();
  applyTheme(localStorage.getItem('kanban_theme') || 'light');
}).catch(err => {
  console.error('IndexedDB failed, falling back to in-memory state:', err);
  state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  // patch save() to no-op so the app still works
  window.save = () => Promise.resolve();
  activeCat = state.categories[0] || null;
  render();
  applyTheme(localStorage.getItem('kanban_theme') || 'light');
});

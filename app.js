'use strict';
/* ============================================================
   캐릭터 카드뉴스 만들기
   - API 키는 앱 내 ⚙ 설정에서 사용자가 직접 입력 → localStorage 저장
   - 미리보기(Canvas 1080×1350)와 다운로드 이미지를 동일하게 렌더링
   ============================================================ */
const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

/* ---------- 상태 ---------- */
const S = {
  apiKey: localStorage.getItem('ccn_api_key') || '',
  chars: [],
  activeCharId: localStorage.getItem('ccn_active') || null,
  topic: null,        // {format, title, desc}
  shape: null,        // SHAPES 항목
  facts: [],
  cards: [],          // 9개: {title, desc, scene, img, imgEl, bg, hlS, hlE}
  page: 0,
  hlMode: false,
  charDraft: null,    // 그린 캐릭터 초안 dataURL (저장 전)
  busy: false,
};
try { S.chars = JSON.parse(localStorage.getItem('ccn_chars') || '[]'); } catch (e) { S.chars = []; }

const activeChar = () => S.chars.find((c) => c.id === S.activeCharId) || null;
function persistChars() {
  try {
    localStorage.setItem('ccn_chars', JSON.stringify(S.chars));
    localStorage.setItem('ccn_active', S.activeCharId || '');
  } catch (e) { alert('저장 공간이 부족해요. 오래된 캐릭터를 지워주세요.'); }
}

/* ---------- 화면 전환 ---------- */
const VIEWS = ['view-char', 'view-topic', 'view-shape', 'view-fact', 'view-editor'];
function showView(id) {
  VIEWS.forEach((v) => { $(v).hidden = v !== id; });
  window.scrollTo(0, 0);
}

/* ---------- Gemini (cardnews-studio 패턴 재사용) ---------- */
const GEMINI_TEXT_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];
async function geminiText(prompt) {
  if (!S.apiKey) throw new Error('NO_KEY');
  for (const m of GEMINI_TEXT_MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(S.apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
    if (r.status === 404) continue;
    if (!r.ok) throw new Error('Gemini 오류 ' + r.status);
    const j = await r.json();
    return j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  }
  throw new Error('사용 가능한 AI 모델이 없어요');
}

/* 이미지 생성: text 프롬프트만 넣으면 텍스트→이미지, refDataUrl이 있으면 img2img */
const GEMINI_IMG_MODELS = ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image'];
async function geminiImage(promptText, refDataUrl) {
  if (!S.apiKey) throw new Error('NO_KEY');
  const parts = [{ text: promptText }];
  if (refDataUrl) {
    const m = refDataUrl.match(/^data:(.*?);base64,(.*)$/s);
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }
  const body = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };
  for (const model of GEMINI_IMG_MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(S.apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 404) continue;
    if (!r.ok) throw new Error('Gemini 이미지 오류 ' + r.status);
    const j = await r.json();
    const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part) throw new Error('이미지 결과를 받지 못했어요');
    return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
  }
  throw new Error('사용 가능한 AI 이미지 모델이 없어요');
}

function parseJsonLoose(t) {
  const clean = String(t).replace(/```json|```/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  return JSON.parse(clean.slice(s, e + 1));
}

function needKey() {
  alert('⚙ 설정에서 Gemini API 키를 먼저 입력해 주세요.');
  openSettings();
}

/* ---------- 이미지 유틸 ---------- */
function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}
/* localStorage 용량 절약을 위해 캐릭터/카드 이미지를 축소 저장 */
function downscaleImage(dataUrl, maxDim, quality) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * s));
      c.height = Math.max(1, Math.round(img.height * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', quality || 0.85));
    };
    img.onerror = rej;
    img.src = dataUrl;
  });
}

/* ---------- 프롬프트 ---------- */
const CHAR_STYLE_TEXT = {
  clay: '말랑한 점토 인형(클레이메이션) 스타일, 부드럽고 통통한 질감',
  photo: '실사 사진 느낌, 자연스러운 사진 스타일',
  watercolor: '따뜻한 수채화 스타일 일러스트',
};
const CHAR_PROMPT = (desc, style) =>
`귀여운 마스코트 캐릭터 일러스트 1종.
설명: ${desc}
스타일: ${CHAR_STYLE_TEXT[style] || CHAR_STYLE_TEXT.clay}
조건: 정면, 전신, 단색 배경, 텍스트·글자·워터마크 금지. 카드뉴스에 반복 등장할 주인공 캐릭터.`;

const CARD_IMG_PROMPT = (scene, ch) =>
`카드뉴스용 세로형 일러스트.
장면: ${scene}
${ch && ch.desc ? '등장 캐릭터 설명: ' + ch.desc + '\n' : ''}등장 캐릭터: 레퍼런스 이미지의 캐릭터
조건: 캐릭터의 생김새·색상·분위기는 레퍼런스 이미지와 똑같이 유지. 밝고 귀여운 분위기, 세로 3:4 구도, 텍스트·글자·워터마크 절대 금지.`;

const PROMPT_TOPICS =
`인스타그램 카드뉴스 주제 5개를 추천해줘.
조건: 20~40대 여성이 저장·공유하고 싶은 생활 밀착형 주제. 번역투·기계체 금지, 한국 인스타 바이럴 채널의 자연스러운 구어체.
반드시 아래 JSON으로만 답해. 다른 말은 쓰지 마.
{"topics":[
  {"format":"자가진단 체크리스트","title":"제목","desc":"두 줄 설명"},
  {"format":"이렇게 하고 이렇게","title":"제목","desc":"두 줄 설명"},
  {"format":"숫자 넣기","title":"제목","desc":"두 줄 설명"},
  {"format":"숨은 TOP 5","title":"제목","desc":"두 줄 설명"},
  {"format":"꿀팁 모음","title":"제목","desc":"두 줄 설명"}
]}`;

const PROMPT_FACTS = (topic) =>
`다음 카드뉴스 주제의 핵심 사실을 3~5개로 정리해줘. 틀린 정보가 있으면 바로잡고, 출처가 불확실한 내용은 빼.
주제: ${topic.title}
설명: ${topic.desc}
형식: ${topic.format}
반드시 JSON으로만 답해. 다른 말은 쓰지 마.
{"facts":["사실1","사실2","사실3"]}`;

const PROMPT_PICK_SHAPE = (topic) =>
`다음 카드뉴스 주제에 가장 잘 어울리는 모양을 하나만 골라줘.
주제: ${topic.title} - ${topic.desc}
후보: compare(이렇게 하고 이렇게: 잘못된 행동 vs 올바른 방법), top5(숨은 TOP 5), caution(이런 습관 조심), tips(꿀팁 모음), steps(단계별 따라하기), mistakes(혼합 실수 모음)
반드시 후보 키 하나만 답해. 다른 말은 쓰지 마.`;

const PROMPT_PLAN = (topic, shape, facts) =>
`다음 카드뉴스의 9장 구성을 만들어줘.
주제: ${topic.title} - ${topic.desc}
모양: ${shape.label} (${shape.sub})
확인된 사실:
${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}
조건:
- 1장은 표지(주제가 한눈에 들어오게), 9장은 마무리(저장·공유 유도)
- 각 장마다: scene(캐릭터가 등장하는 일러스트 장면, 구체적으로 1~2문장), title(큰 제목, 15자 이내 후킹 문구), desc(아래 작은 설명, 1~2문장 구어체)
- title에서 가장 강조할 단어는 [[ ]]로 감싸줘. 예: [[감기약]] 이렇게 먹으면 위험해요
- 번역투 금지, 한국 인스타 바이럴 채널의 자연스러운 구어체
반드시 JSON으로만 답해. 다른 말은 쓰지 마.
{"cards":[
  {"scene":"장면 설명","title":"큰 제목","desc":"작은 설명"}
]}`;

/* ---------- 처음 설정 (더미 통과) ---------- */
function initOnboard() {
  if (localStorage.getItem('ccn_setup')) return;
  $('onboard').hidden = false;
  const done = (v) => {
    try { localStorage.setItem('ccn_setup', v); } catch (e) {}
    $('onboard').hidden = true;
  };
  on('btn-acct', 'click', () => done('account'));
  on('btn-code', 'click', () => done('code'));
}

/* ---------- 설정 모달 ---------- */
function openSettings() {
  $('api-key').value = S.apiKey;
  $('settings-modal').hidden = false;
}

/* ---------- 스텝 탭 ---------- */
function initTabs() {
  $$('.steptab').forEach((b) => b.addEventListener('click', () => {
    $$('.steptab').forEach((x) => x.classList.toggle('active', x === b));
    ['make', 'tone', 'manage'].forEach((t) => { $('tab-' + t).hidden = b.dataset.tab !== t; });
    if (b.dataset.tab === 'manage') renderCharGrid();
  }));
}

/* ---------- 캐릭터 ---------- */
function renderActiveChar() {
  const c = activeChar();
  $('active-char-img').hidden = !c;
  $('active-char-empty').hidden = !!c;
  $('btn-clear-char').hidden = !c;
  if (c) $('active-char-img').src = c.dataUrl;
  $('btn-to-topic').disabled = !c;
}

function renderCharGrid() {
  const g = $('char-grid');
  g.innerHTML = '';
  if (!S.chars.length) { g.innerHTML = '<p class="muted">저장된 캐릭터가 없어요.</p>'; return; }
  S.chars.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'char-cell';
    const img = document.createElement('img');
    img.alt = '캐릭터'; img.src = c.dataUrl;
    const btns = document.createElement('div');
    btns.className = 'char-cell-btns';
    const use = document.createElement('button');
    use.className = 'btn-mini';
    use.textContent = c.id === S.activeCharId ? '사용 중' : '사용하기';
    use.disabled = c.id === S.activeCharId;
    use.onclick = () => { S.activeCharId = c.id; persistChars(); renderActiveChar(); renderCharGrid(); };
    const del = document.createElement('button');
    del.className = 'btn-mini danger'; del.textContent = '삭제';
    del.onclick = () => {
      if (!confirm('이 캐릭터를 지울까요?')) return;
      S.chars = S.chars.filter((x) => x.id !== c.id);
      if (S.activeCharId === c.id) S.activeCharId = null;
      persistChars(); renderActiveChar(); renderCharGrid();
    };
    btns.append(use, del);
    d.append(img, btns);
    g.appendChild(d);
  });
}

function initCharacter() {
  on('btn-clear-char', 'click', () => {
    if (!confirm('지금 쓰는 캐릭터를 지울까요? (목록에는 남아있어요)')) return;
    S.activeCharId = null; persistChars(); renderActiveChar();
  });
  on('btn-make-voice', 'click', () => { $('char-modal').hidden = false; });
  on('btn-close-char', 'click', () => { $('char-modal').hidden = true; });
  on('btn-char-example', 'click', () => { $('char-desc').value = '돈 버는 쥐, 귀엽게'; });
  on('btn-draw-char', 'click', async () => {
    if (!S.apiKey) return needKey();
    const desc = $('char-desc').value.trim();
    if (!desc) { alert('캐릭터 설명을 적어주세요.'); return; }
    const styleEl = document.querySelector('input[name="char-style"]:checked');
    const style = styleEl ? styleEl.value : 'clay';
    const btn = $('btn-draw-char');
    btn.disabled = true; btn.textContent = '그리는 중...';
    try {
      const url = await geminiImage(CHAR_PROMPT(desc, style), null);
      S.charDraft = await downscaleImage(url, 640);
      $('char-preview').src = S.charDraft;
      $('char-preview-wrap').hidden = false;
    } catch (e) { alert('그리기 실패: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '✨ 캐릭터 그리기'; }
  });
  on('btn-save-char', 'click', () => {
    if (!S.charDraft) { alert('먼저 [캐릭터 그리기]를 눌러주세요.'); return; }
    const c = { id: 'c' + Date.now(), dataUrl: S.charDraft, desc: $('char-desc').value.trim() };
    S.chars.push(c); S.activeCharId = c.id; persistChars();
    S.charDraft = null; $('char-preview-wrap').hidden = true;
    $('char-modal').hidden = true; renderActiveChar();
  });
  on('btn-upload-photo', 'click', () => $('file-char').click());
  on('file-char', 'change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const url = await readFileAsDataURL(f);
      const small = await downscaleImage(url, 640);
      const c = { id: 'c' + Date.now(), dataUrl: small, desc: '사진 등록' };
      S.chars.push(c); S.activeCharId = c.id; persistChars(); renderActiveChar();
    } catch (err) { alert('사진 읽기 실패: ' + err.message); }
  });
  on('btn-to-topic', 'click', () => showView('view-topic'));
  on('btn-back-char', 'click', () => showView('view-char'));
}

/* ---------- 주제 추천 ---------- */
function renderTopicCard(t) {
  const d = document.createElement('div');
  d.className = 'topic-card';
  const f = document.createElement('div'); f.className = 'topic-format'; f.textContent = t.format || '';
  const h = document.createElement('div'); h.className = 'topic-title'; h.textContent = t.title || '';
  const p = document.createElement('div'); p.className = 'topic-desc'; p.textContent = t.desc || '';
  const b = document.createElement('button'); b.className = 'btn-primary'; b.textContent = '이걸로 만들기 →';
  b.onclick = () => { S.topic = t; buildShapeList(); showView('view-shape'); };
  d.append(f, h, p, b);
  $('topic-list').appendChild(d);
}

function initTopics() {
  on('btn-topics', 'click', async () => {
    if (!S.apiKey) return needKey();
    const btn = $('btn-topics');
    btn.disabled = true; btn.textContent = '✨ 추천받는 중...';
    $('topic-list').innerHTML = '';
    try {
      const t = await geminiText(PROMPT_TOPICS);
      const j = parseJsonLoose(t);
      const arr = (j.topics || []).slice(0, 5);
      if (!arr.length) throw new Error('추천을 받지 못했어요');
      arr.forEach(renderTopicCard);
    } catch (e) { alert('주제 추천 실패: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '✨ 주제 5개 추천받기'; }
  });
}

/* ---------- 모양 선택 ---------- */
const SHAPES = [
  { key: 'ai',       label: '🤖 AI가 알아서 골라주기', sub: '주제에 딱 맞는 모양을 골라줘요' },
  { key: 'compare',  label: '이렇게 하고 이렇게',     sub: '잘못된 행동 vs 올바른 방법' },
  { key: 'top5',     label: '숨은 TOP 5',              sub: '잘 알려지지 않은 5가지' },
  { key: 'caution',  label: '이런 습관 조심',          sub: '조심해야 할 습관들' },
  { key: 'tips',     label: '꿀팁 모음',               sub: '바로 써먹는 꿀팁들' },
  { key: 'steps',    label: '단계별 따라하기',         sub: '1단계부터 차근차근' },
  { key: 'mistakes', label: '혼합 실수 모음',          sub: '흔한 실수들 모아보기' },
];
function buildShapeList() {
  const w = $('shape-list');
  w.innerHTML = '';
  SHAPES.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'shape-btn';
    const l = document.createElement('div'); l.className = 'shape-label'; l.textContent = s.label;
    const sub = document.createElement('div'); sub.className = 'shape-sub'; sub.textContent = s.sub;
    b.append(l, sub);
    b.onclick = () => pickShape(s.key);
    w.appendChild(b);
  });
}
async function pickShape(key) {
  if (!S.apiKey) return needKey();
  if (key === 'ai') {
    try {
      const t = await geminiText(PROMPT_PICK_SHAPE(S.topic));
      const k = (String(t).match(/compare|top5|caution|tips|steps|mistakes/) || [])[0] || 'tips';
      S.shape = SHAPES.find((s) => s.key === k);
      alert('AI가 "' + S.shape.label + '" 모양을 골랐어요!');
    } catch (e) { alert('모양 고르기 실패: ' + e.message); return; }
  } else {
    S.shape = SHAPES.find((s) => s.key === key);
  }
  startFactCheck();
}

/* ---------- 팩트체크 ---------- */
async function startFactCheck() {
  showView('view-fact');
  $('fact-loading').hidden = false;
  $('fact-result').hidden = true;
  try {
    const t = await geminiText(PROMPT_FACTS(S.topic));
    const j = parseJsonLoose(t);
    S.facts = (j.facts || []).slice(0, 5);
    if (!S.facts.length) throw new Error('팩트를 정리하지 못했어요');
    const ul = $('fact-list');
    ul.innerHTML = '';
    S.facts.forEach((f) => {
      const li = document.createElement('li');
      li.textContent = f;
      ul.appendChild(li);
    });
    $('fact-loading').hidden = true;
    $('fact-result').hidden = false;
  } catch (e) {
    $('fact-loading').hidden = true;
    alert('팩트체크 실패: ' + e.message);
  }
}

/* ---------- 9장 구성 생성 ---------- */
async function buildCards() {
  if (S.busy) return;
  S.busy = true;
  const btn = $('btn-start-cards');
  btn.disabled = true; btn.textContent = '구성 만드는 중...';
  try {
    const t = await geminiText(PROMPT_PLAN(S.topic, S.shape, S.facts));
    const j = parseJsonLoose(t);
    const arr = (j.cards || []).slice(0, 9);
    if (arr.length < 9) throw new Error('9장 구성을 받지 못했어요');
    S.cards = arr.map((c) => ({
      title: c.title || '', desc: c.desc || '', scene: c.scene || '',
      img: null, imgEl: null, bg: 'default', hlS: null, hlE: null,
    }));
    S.page = 0;
    showView('view-editor');
    renderPage();
    generateCardImages(); // 백그라운드에서 순차 생성
  } catch (e) { alert('카드 구성 실패: ' + e.message); }
  finally { S.busy = false; btn.disabled = false; btn.textContent = '카드 만들기 시작'; }
}

/* 카드별 일러스트: 캐릭터 레퍼런스 img2img로 순차 생성 */
async function generateCardImages() {
  const bar = $('img-progress');
  bar.hidden = false;
  const ch = activeChar();
  for (let i = 0; i < S.cards.length; i++) {
    const card = S.cards[i];
    if (card.img) continue;
    bar.textContent = `🖼 ${i + 1}번째 장 그림 그리는 중... (${i + 1}/9)`;
    try {
      const url = await geminiImage(CARD_IMG_PROMPT(card.scene, ch), ch ? ch.dataUrl : null);
      card.img = await downscaleImage(url, 1080);
      card.imgEl = null;
    } catch (e) { card.img = null; /* 실패한 장은 나중에 [그림 다시 그리기] */ }
    if (i === S.page) renderPreview();
  }
  bar.hidden = true;
}

/* ---------- 카드 렌더러 (미리보기 = 다운로드, 1080×1350) ---------- */
const BG_COLORS = [
  ['default', '기본', '#FFFDF6'],
  ['red',     '빨강', '#FFE9E9'],
  ['purple',  '자주', '#F1E7FF'],
  ['orange',  '주황', '#FFF0DE'],
  ['pink',    '분홍', '#FFE9F4'],
  ['blue',    '파랑', '#E9F1FF'],
  ['green',   '초록', '#E9F8EC'],
];
const bgHex = (k) => (BG_COLORS.find((b) => b[0] === k) || BG_COLORS[0])[2];

const CARD_W = 1080, CARD_H = 1350, IMG_H = 740;

/* [[ ]] 파싱 → 문자 단위 줄바꿈 레이아웃 */
function layoutTitle(ctx, text, maxWidth) {
  const segs = [];
  const re = /\[\[(.+?)\]\]/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ t: text.slice(last, m.index), hl: false });
    segs.push({ t: m[1], hl: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ t: text.slice(last), hl: false });
  const chars = [];
  segs.forEach((s) => { for (const ch of s.t) chars.push({ ch, hl: s.hl }); });
  const lines = [];
  let line = [], w = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    c.w = ctx.measureText(c.ch).width;
    c.i = i;
    if (w + c.w > maxWidth && line.length > 0) { lines.push({ chars: line, w }); line = []; w = 0; }
    line.push(c); w += c.w;
  }
  if (line.length) lines.push({ chars: line, w });
  return { chars, lines };
}

function drawCard(ctx, card) {
  /* 위: 일러스트 */
  if (card.imgEl && card.imgEl.complete && card.imgEl.naturalWidth) {
    const iw = card.imgEl.naturalWidth, ih = card.imgEl.naturalHeight;
    const s = Math.max(CARD_W / iw, IMG_H / ih);
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(card.imgEl, (CARD_W - dw) / 2, (IMG_H - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = '#f4f1fa';
    ctx.fillRect(0, 0, CARD_W, IMG_H);
    ctx.fillStyle = '#8a8a99';
    ctx.font = '44px "Pretendard Variable", Pretendard, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🖼 그림을 만들고 있어요...', CARD_W / 2, IMG_H / 2);
  }
  /* 아래: 바탕색 */
  ctx.fillStyle = bgHex(card.bg);
  ctx.fillRect(0, IMG_H, CARD_W, CARD_H - IMG_H);

  /* 큰 제목 (가운데 정렬, [[ ]]·드래그 노랑 강조) */
  ctx.font = '92px "Black Han Sans", sans-serif';
  ctx.textBaseline = 'alphabetic';
  const { lines } = layoutTitle(ctx, card.title || '', 940);
  const lh = 118;
  let y = IMG_H + 118;
  const titleLayout = [];
  lines.forEach((ln) => {
    const x0 = (CARD_W - ln.w) / 2;
    let x = x0;
    const crects = [];
    ln.chars.forEach((c) => {
      const hl = c.hl || (card.hlS !== null && card.hlS !== undefined && c.i >= card.hlS && c.i <= card.hlE);
      if (hl) { ctx.fillStyle = '#ffe14d'; ctx.fillRect(x - 2, y - 84, c.w + 4, 106); }
      crects.push({ x, w: c.w, i: c.i });
      x += c.w;
    });
    ctx.fillStyle = '#1c1c28';
    ctx.textAlign = 'left';
    ctx.fillText(ln.chars.map((c) => c.ch).join(''), x0, y);
    titleLayout.push({ top: y - 90, bottom: y + 26, chars: crects });
    y += lh;
  });

  /* 아래 작은 설명 */
  ctx.font = '40px "Pretendard Variable", Pretendard, sans-serif';
  const dlines = [];
  let dl = '', dw = 0;
  for (const ch of (card.desc || '')) {
    const cw = ctx.measureText(ch).width;
    if (dw + cw > 940 && dl) { dlines.push({ t: dl, w: dw }); dl = ''; dw = 0; }
    dl += ch; dw += cw;
  }
  if (dl) dlines.push({ t: dl, w: dw });
  ctx.fillStyle = '#5a5a6a';
  ctx.textAlign = 'left';
  let dy = y + 26;
  dlines.slice(0, 4).forEach((ln) => {
    ctx.fillText(ln.t, (CARD_W - ln.w) / 2, dy);
    dy += 62;
  });
  return titleLayout;
}

function ensureImg(card) {
  return new Promise((res) => {
    if (!card.img || card.imgEl) return res();
    const im = new Image();
    im.onload = () => { card.imgEl = im; res(); };
    im.onerror = () => res();
    im.src = card.img;
  });
}

let titleLayout = [];
function renderPreview() {
  const card = S.cards[S.page];
  if (!card) return;
  const ctx = $('preview').getContext('2d');
  ensureImg(card).then(() => { titleLayout = drawCard(ctx, card); });
}

/* ---------- 편집기 ---------- */
function buildBgColors(card) {
  const w = $('bg-colors');
  w.innerHTML = '';
  BG_COLORS.forEach(([k, label, hex]) => {
    const b = document.createElement('button');
    b.className = 'color-chip' + (card.bg === k ? ' active' : '');
    b.style.background = hex;
    b.textContent = label;
    b.onclick = () => { card.bg = k; buildBgColors(card); renderPreview(); };
    w.appendChild(b);
  });
}

function renderPage() {
  const card = S.cards[S.page];
  if (!card) return;
  $('page-label').textContent = `${S.page + 1}번째 장 / 9장`;
  $('in-title').value = card.title;
  $('in-desc').value = card.desc;
  $('btn-prev').disabled = S.page === 0;
  $('btn-next').disabled = S.page === 8;
  buildBgColors(card);
  $('scene-hint').textContent = card.scene ? ('그림 설명: ' + card.scene) : '';
  renderPreview();
}

function canvasToBlob(cv) {
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}

function initEditor() {
  on('btn-prev', 'click', () => { if (S.page > 0) { S.page--; renderPage(); } });
  on('btn-next', 'click', () => { if (S.page < 8) { S.page++; renderPage(); } });
  on('in-title', 'input', () => {
    const c = S.cards[S.page]; if (!c) return;
    c.title = $('in-title').value;
    c.hlS = null; c.hlE = null; // 글자가 바뀌면 드래그 강조 초기화
    renderPreview();
  });
  on('in-desc', 'input', () => {
    const c = S.cards[S.page]; if (!c) return;
    c.desc = $('in-desc').value;
    renderPreview();
  });
  on('btn-hl-mode', 'click', () => {
    S.hlMode = !S.hlMode;
    $('btn-hl-mode').classList.toggle('active', S.hlMode);
    $('preview').classList.toggle('hl-on', S.hlMode);
    $('btn-hl-mode').textContent = S.hlMode ? '🖍 강조 모드 ON (드래그하세요)' : '🖍 고른 글자 강조';
  });
  on('btn-hl-clear', 'click', () => {
    const c = S.cards[S.page]; if (!c) return;
    c.hlS = null; c.hlE = null; renderPreview();
  });
  on('btn-redraw', 'click', async () => {
    if (!S.apiKey) return needKey();
    const card = S.cards[S.page]; if (!card) return;
    const ch = activeChar();
    const btn = $('btn-redraw');
    btn.disabled = true; btn.textContent = '그리는 중...';
    try {
      const url = await geminiImage(CARD_IMG_PROMPT(card.scene, ch), ch ? ch.dataUrl : null);
      card.img = await downscaleImage(url, 1080);
      card.imgEl = null;
      renderPreview();
    } catch (e) { alert('다시 그리기 실패: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '🔄 그림 다시 그리기'; }
  });
  on('btn-use-photo', 'click', () => $('file-card-photo').click());
  on('file-card-photo', 'change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const card = S.cards[S.page]; if (!card) return;
    try {
      const url = await readFileAsDataURL(f);
      card.img = await downscaleImage(url, 1080);
      card.imgEl = null;
      renderPreview();
    } catch (err) { alert('사진 읽기 실패: ' + err.message); }
  });
  on('btn-save-page', 'click', async () => {
    const blob = await canvasToBlob($('preview'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `캐릭터카드뉴스-${S.page + 1}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  on('btn-save-all', 'click', async () => {
    if (typeof JSZip === 'undefined') { alert('JSZip을 불러오지 못했어요. 인터넷 연결을 확인해주세요.'); return; }
    const btn = $('btn-save-all');
    btn.disabled = true; btn.textContent = '저장 준비 중...';
    try {
      const zip = new JSZip();
      for (let i = 0; i < S.cards.length; i++) {
        const cv = document.createElement('canvas');
        cv.width = CARD_W; cv.height = CARD_H;
        const card = S.cards[i];
        await ensureImg(card);
        drawCard(cv.getContext('2d'), card);
        const blob = await canvasToBlob(cv);
        zip.file(`캐릭터카드뉴스-${i + 1}.png`, blob);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '캐릭터카드뉴스-9장.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { alert('전체 저장 실패: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '📦 전체 저장'; }
  });

  /* 미리보기 드래그 하이라이트 */
  const prev = $('preview');
  let dragStart = null;
  const canvasPos = (e) => {
    const r = prev.getBoundingClientRect();
    return { x: (e.clientX - r.left) * CARD_W / r.width, y: (e.clientY - r.top) * CARD_H / r.height };
  };
  const charAt = (x, y) => {
    for (const ln of titleLayout) {
      if (y >= ln.top && y <= ln.bottom) {
        for (const c of ln.chars) if (x >= c.x && x <= c.x + c.w) return c.i;
      }
    }
    return null;
  };
  prev.addEventListener('pointerdown', (e) => {
    if (!S.hlMode) return;
    const p = canvasPos(e);
    const i = charAt(p.x, p.y);
    if (i === null) return;
    dragStart = i;
    try { prev.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  prev.addEventListener('pointermove', (e) => {
    if (dragStart === null) return;
    const p = canvasPos(e);
    const i = charAt(p.x, p.y);
    if (i === null) return;
    const card = S.cards[S.page]; if (!card) return;
    card.hlS = Math.min(dragStart, i);
    card.hlE = Math.max(dragStart, i);
    renderPreview();
  });
  prev.addEventListener('pointerup', () => { dragStart = null; });
  prev.addEventListener('pointercancel', () => { dragStart = null; });
}

/* ---------- 부트 ---------- */
function init() {
  initOnboard();
  on('btn-settings', 'click', openSettings);
  on('btn-close-settings', 'click', () => { $('settings-modal').hidden = true; });
  on('btn-save-key', 'click', () => {
    S.apiKey = $('api-key').value.trim();
    try { localStorage.setItem('ccn_api_key', S.apiKey); } catch (e) {}
    $('settings-modal').hidden = true;
    alert('저장됐어요.');
  });
  initTabs();
  initCharacter();
  initTopics();
  on('btn-back-topic', 'click', () => showView('view-topic'));
  on('btn-back-shape', 'click', () => showView('view-shape'));
  on('btn-start-cards', 'click', buildCards);
  initEditor();
  renderActiveChar();
  showView('view-char');
  /* 웹폰트가 늦게 뜨면 카드 글꼴이 바뀌므로 준비되면 다시 렌더 */
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (!$('view-editor').hidden) renderPreview(); });
  }
}
init();

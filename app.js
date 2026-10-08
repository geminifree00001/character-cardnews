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
  name: localStorage.getItem('ccn_name') || '',
  code: localStorage.getItem('ccn_code') || '',
  chars: [],
  activeCharId: localStorage.getItem('ccn_active') || null,
  src: 'recommend',   // recommend | link | direct
  topic: null,        // {format, title, hook, reason, desc}
  shape: null,        // SHAPES 항목
  field: '',          // 분야 (2~4자)
  cards: [],          // {title, desc, scene, img, imgEl, bg, hlS, hlE, stamp, gen}
  page: 0,
  pageCount: 9,       // 선택한 장수 (4/6/8/9/10)
  hlMode: false,
  charDraft: null,
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
function persistSetup() {
  try {
    localStorage.setItem('ccn_name', S.name);
    localStorage.setItem('ccn_code', S.code);
  } catch (e) {}
}

/* ---------- 화면 전환 ---------- */
const VIEWS = ['view-main', 'view-topics', 'view-summary', 'view-editor'];
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
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---------- 모양 21종 ---------- */
const SHAPES = [
  { key: 'ai',         label: '🪄 AI가 알아서 골라주기', sub: '예) 주제에 제일 잘 맞는 모양으로' },
  { key: 'caution',    label: '⚠️ 이런 습관 조심',       sub: '예) 피부 망치는 습관 5가지' },
  { key: 'ox',         label: '⭕ 진짜? 가짜? (O/X)',    sub: '예) 다들 믿는 이 말, 사실일까?' },
  { key: 'compare',    label: '🔄 이렇게 말고 이렇게',   sub: '예) 잘못된 방법 vs 올바른 방법' },
  { key: 'tips',       label: '💡 꿀팁 모음',            sub: '예) 알아두면 좋은 꿀팁 5' },
  { key: 'checklist',  label: '✅ 자가진단 체크리스트',  sub: '예) 나도 해당될까? 체크해보세요' },
  { key: 'top5',       label: '🏆 순위 TOP 5',           sub: '예) 가장 흔한 실수 TOP 5' },
  { key: 'steps',      label: '🪜 단계별 따라하기',      sub: '예) 처음이라면 이 순서대로' },
  { key: 'qa',         label: '🙋 자주 묻는 질문 Q&A',  sub: '예) 많이 물어보시는 질문 모음' },
  { key: 'quiz',       label: '❓ 퀴즈 풀기',            sub: '예) 3문제 다 맞히면 전문가!' },
  { key: 'mistakes',   label: '🐥 흔한 실수 모음',      sub: '예) 나도 모르게 하던 실수' },
  { key: 'routine',    label: '⏰ 하루 루틴',            sub: '예) 아침부터 밤까지 이렇게' },
  { key: 'numbers',    label: '🔢 숫자로 알아보기',     sub: '예) 숫자로 보면 깜짝 놀라요' },
  { key: 'comfort',    label: '🤗 공감·위로',           sub: '예) 혹시 나만 이런가요?' },
  { key: 'story',      label: '📖 이야기로 풀기',       sub: '예) 마스코트의 하루로 보는 OO' },
  { key: 'chat',       label: '💬 대화형 (묻고 답하기)', sub: '예) 친구가 물었다, OO 괜찮아?' },
  { key: 'easy',       label: '📚 어려운 말 쉽게',      sub: '예) 이 단어, 무슨 뜻일까?' },
  { key: 'situ',       label: '🎯 상황별 추천',         sub: '예) 이럴 땐 이렇게 하세요' },
  { key: 'season',     label: '🍂 계절·시기 가이드',    sub: '예) 지금 이 시기에 꼭 챙길 것' },
  { key: 'news',       label: '📰 요즘 이슈 정리',      sub: '예) 화제의 그 소식, 3분 정리' },
  { key: 'beforeafter',label: '🔄 전과 후 비교',        sub: '예) 바꾸기 전 vs 바꾼 후' },
];
S.shape = SHAPES[0];

/* ---------- 프롬프트 ---------- */
const CHAR_STYLE_TEXT = {
  style3d: '3D 애니메이션 스타일 (픽사 느낌), 부드러운 3D 렌더링',
  book: '귀여운 그림책 일러스트 스타일',
  clay: '말랑한 점토 인형(클레이메이션) 스타일, 부드럽고 통통한 질감',
  watercolor: '따뜻한 수채화 스타일 일러스트',
  photo: '실사 사진 느낌, 자연스러운 사진 스타일',
};
const CHAR_PROMPT = (desc, style) =>
`귀여운 마스코트 캐릭터 일러스트 1종.
설명: ${desc}
스타일: ${CHAR_STYLE_TEXT[style] || CHAR_STYLE_TEXT.style3d}
조건: 정면, 전신, 단색 배경, 텍스트·글자·워터마크 금지. 카드뉴스에 반복 등장할 주인공 캐릭터.`;

const CARD_IMG_PROMPT = (scene, ch) =>
`카드뉴스용 세로형 일러스트.
장면: ${scene}
${ch && ch.desc ? '등장 캐릭터 설명: ' + ch.desc + '\n' : ''}등장 캐릭터: 레퍼런스 이미지의 캐릭터
조건: 캐릭터의 생김새·색상·분위기는 레퍼런스 이미지와 똑같이 유지. 밝고 귀여운 분위기, 세로 3:4 구도, 텍스트·글자·워터마크 절대 금지.`;

const PROMPT_TOPICS = (direction) =>
`인스타그램 카드뉴스 주제 5개를 추천해줘.
원하는 방향: ${direction || '없음'}
조건: 20~40대 여성이 저장·공유하고 싶은 생활 밀착형 주제. 번역투·기계체 금지, 한국 인스타 바이럴 채널의 자연스러운 구어체.
각 주제의 형식(format)은 아래 중 하나를 골라 정확히 그대로 써줘:
"🪄 AI가 알아서 골라주기", "⚠️ 이런 습관 조심", "⭕ 진짜? 가짜? (O/X)", "🔄 이렇게 말고 이렇게", "💡 꿀팁 모음", "✅ 자가진단 체크리스트", "🏆 순위 TOP 5", "🪜 단계별 따라하기", "🙋 자주 묻는 질문 Q&A", "❓ 퀴즈 풀기", "🐥 흔한 실수 모음", "⏰ 하루 루틴", "🔢 숫자로 알아보기", "🤗 공감·위로", "📖 이야기로 풀기", "💬 대화형 (묻고 답하기)", "📚 어려운 말 쉽게", "🎯 상황별 추천", "🍂 계절·시기 가이드", "📰 요즘 이슈 정리", "🔄 전과 후 비교"
반드시 아래 JSON으로만 답해. 다른 말은 쓰지 마.
{"topics":[
  {"format":"형식","title":"제목","hook":"훅 문장","reason":"선택 이유 1줄"},
  {"format":"형식","title":"제목","hook":"훅 문장","reason":"선택 이유 1줄"},
  {"format":"형식","title":"제목","hook":"훅 문장","reason":"선택 이유 1줄"},
  {"format":"형식","title":"제목","hook":"훅 문장","reason":"선택 이유 1줄"},
  {"format":"형식","title":"제목","hook":"훅 문장","reason":"선택 이유 1줄"}
]}`;

const PROMPT_LINK = (url) =>
`다음 URL의 내용을 바탕으로 인스타그램 카드뉴스 주제 1개를 정리해줘.
URL: ${url}
(URL에 직접 접속할 수 없으면 URL 자체에서 유추되는 주제로 정리해줘.)
조건: 번역투 금지, 한국 인스타 바이럴 채널의 자연스러운 구어체.
반드시 JSON으로만 답해. 다른 말은 쓰지 마.
{"title":"주제 제목","desc":"주제 설명 2줄"}`;

const PROMPT_PICK_SHAPE = (topic) =>
`다음 카드뉴스 주제에 가장 잘 어울리는 모양의 키를 하나만 골라줘.
주제: ${topic.title} - ${topic.desc || ''}
후보 키: caution, ox, compare, tips, checklist, top5, steps, qa, quiz, mistakes, routine, numbers, comfort, story, chat, easy, situ, season, news, beforeafter
반드시 후보 키 하나만 답해. 다른 말은 쓰지 마.`;

const PROMPT_SHAPE_REASON = (topic, shape) =>
`카드뉴스 주제 "${topic.title}"에 "${shape.label}" 형식을 선택한 이유를 2~3줄로 설명해줘.
조건: 번역투·기계체 금지, 한국 인스타 바이럴 채널의 자연스러운 구어체.
이유만 답하고 다른 말은 쓰지 마.`;

const PROMPT_PLAN = (topic, shape, n) =>
`다음 카드뉴스의 ${n}장 구성을 만들어줘.
주제: ${topic.title} - ${topic.desc || ''}
모양: ${shape.label} (${shape.sub})
조건:
- 1장은 표지(주제가 한눈에 들어오게), 마지막 ${n}장은 팔로우 유도 마무리(팔로우·저장·공유 요청을 따뜻하고 자연스럽게)
- 각 장마다: scene(캐릭터가 등장하는 일러스트 장면, 구체적으로 1~2문장), title(큰 제목, 15자 이내 후킹 문구), desc(아래 작은 설명, 1~2문장 구어체)
- 마지막 장의 scene은 캐릭터가 팔로우를 유도하는 장면으로 해줘
- title에서 가장 강조할 단어는 [[ ]]로 감싸줘. 예: [[감기약]] 이렇게 먹으면 위험해요
- 번역투 금지, 한국 인스타 바이럴 채널의 자연스러운 구어체
- 맨 마지막에 "field"로 이 주제의 분야를 2~4자로 적어줘. 예: 건강정보
반드시 JSON으로만 답해. 다른 말은 쓰지 마.
{"field":"분야","cards":[
  {"scene":"장면 설명","title":"큰 제목","desc":"작은 설명"}
]}`;

/* 마지막 장: 팔로우 유도 이미지 (캐릭터 스타일에 어울리게) */
const FOLLOW_IMG_PROMPT = (ch) =>
`카드뉴스 마지막 장용 세로형 일러스트.
장면: 등장 캐릭터가 밝게 웃으며 한 손으로 화면 위쪽의 '팔로우' 버튼을 가리키고 있다. 주변에 작은 하트와 별 장식이 흩어져 있다. 따뜻하고 사랑스러운 분위기.
${ch && ch.desc ? '등장 캐릭터 설명: ' + ch.desc + '\n' : ''}등장 캐릭터: 레퍼런스 이미지의 캐릭터
조건: 캐릭터의 생김새·색상·분위기는 레퍼런스 이미지와 똑같이 유지. 밝고 귀여운 분위기, 세로 3:4 구도, 텍스트·글자·워터마크 절대 금지.`;

const isLastCard = (idx) => S.cards.length > 0 && idx === S.cards.length - 1;
const imgPromptFor = (card, idx, ch) =>
  isLastCard(idx) ? FOLLOW_IMG_PROMPT(ch) : CARD_IMG_PROMPT(card.scene, ch);

/* ---------- 설정 모달 ---------- */
function openSettings() {
  $('api-key').value = S.apiKey;
  $('settings-modal').hidden = false;
}

/* ---------- 메인 화면 Gemini 키 박스 ---------- */
function saveApiKey(v) {
  S.apiKey = (v || '').trim();
  try { localStorage.setItem('ccn_api_key', S.apiKey); } catch (e) {}
  $('api-key').value = S.apiKey;
  $('api-key-main').value = '';
  refreshKeyBox();
}
function refreshKeyBox() {
  const has = !!S.apiKey;
  $('key-input-row').hidden = has;
  $('key-done-row').hidden = !has;
  $('key-box').classList.toggle('done', has);
  if (has) {
    const tail = S.apiKey.slice(-4);
    $('key-status').textContent = `✅ 키 등록됨 (••••${tail})`;
  }
}

/* ---------- 처음 설정 모달 ---------- */
function setupTab(name) {
  $$('.setup-tab').forEach((b) => b.classList.toggle('active', b.dataset.stab === name));
  ['acct', 'code', 'char'].forEach((t) => { $('stab-' + t).hidden = t !== name; });
  updateSetupTabChecks();
}
function updateSetupTabChecks() {
  const done = { acct: !!S.name, code: !!S.code, char: !!activeChar() };
  const labels = { acct: '1. 내 계정', code: '2. 입장코드', char: '3. 캐릭터' };
  $$('.setup-tab').forEach((b) => {
    const t = b.dataset.stab;
    b.textContent = (done[t] ? '✅ ' : '') + labels[t];
  });
  $('code-notice').hidden = !!S.code;
}
function openSetup(tab) {
  $('in-name').value = S.name;
  $('in-code').value = S.code;
  renderSetupChar();
  setupTab(tab || 'acct');
  $('setup-modal').hidden = false;
}
function renderSetupChar() {
  const c = activeChar();
  $('setup-char-img').hidden = !c;
  $('btn-setup-clear-char').hidden = !c;
  $('setup-char-title').textContent = c ? '지금 쓰는 캐릭터' : '? 아직 캐릭터가 없어요';
  if (c) $('setup-char-img').src = c.dataUrl;
  $('btn-goto-main').hidden = !c;
}

function initSetup() {
  $$('.setup-tab').forEach((b) => b.addEventListener('click', () => setupTab(b.dataset.stab)));
  on('btn-setup-close', 'click', () => { $('setup-modal').hidden = true; refreshMain(); });
  on('btn-setup-done', 'click', () => {
    if (S.charDraft) saveCharDraft();
    $('setup-modal').hidden = true; refreshMain();
  });
  on('btn-setup-back', 'click', () => setupTab('code'));
  on('btn-goto-main', 'click', () => { $('setup-modal').hidden = true; refreshMain(); showView('view-main'); });

  /* 탭1: 내 계정 */
  on('btn-save-name', 'click', () => {
    const v = $('in-name').value.trim();
    if (!v) { alert('표시 이름을 적어주세요.'); return; }
    S.name = v; persistSetup(); updateSetupTabChecks(); refreshMain();
  });

  /* 탭2: 입장코드 (더미 통과) */
  on('btn-save-code', 'click', () => {
    const v = $('in-code').value.trim();
    if (!v) { alert('입장코드를 입력하세요.'); return; }
    S.code = v; persistSetup(); updateSetupTabChecks(); refreshMain();
    setupTab('char');
  });
  on('btn-goto-code', 'click', () => setupTab('code'));

  /* 탭3: 캐릭터 */
  on('btn-voice-form', 'click', () => { $('char-form').hidden = !$('char-form').hidden; });
  on('btn-char-example2', 'click', () => {
    $('char-form').hidden = false;
    $('char-desc').value = '동글동글한 노란 병아리, 초록색 앞치마를 두르고 환하게 웃는 모습';
  });
  on('btn-draw-char', 'click', async () => {
    if (!S.apiKey) return needKey();
    if (!S.code) { setupTab('code'); alert('입장코드를 먼저 넣어주세요.'); return; }
    const desc = $('char-desc').value.trim();
    if (!desc) { alert('캐릭터 설명을 적어주세요.'); return; }
    const styleEl = document.querySelector('input[name="char-style"]:checked');
    const style = styleEl ? styleEl.value : 'style3d';
    const btn = $('btn-draw-char');
    btn.disabled = true; btn.textContent = '그리는 중...';
    try {
      const url = await geminiImage(CHAR_PROMPT(desc, style), null);
      S.charDraft = await downscaleImage(url, 640);
      S.charDraftDesc = desc;
      $('char-preview').src = S.charDraft;
      $('char-preview-wrap').hidden = false;
    } catch (e) { alert('그리기 실패: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '🎨 캐릭터 그리기'; }
  });
  /* 캐릭터 초안은 [저장하고 닫기]를 누르면 저장됨 */
  on('btn-photo-upload', 'click', () => $('file-char').click());
  on('file-char', 'change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const url = await readFileAsDataURL(f);
      const small = await downscaleImage(url, 640);
      const c = { id: 'c' + Date.now(), dataUrl: small, desc: '사진 등록' };
      S.chars.push(c); S.activeCharId = c.id; persistChars();
      renderSetupChar(); updateSetupTabChecks(); refreshMain();
    } catch (err) { alert('사진 읽기 실패: ' + err.message); }
  });
  on('btn-setup-clear-char', 'click', () => {
    if (!confirm('지금 쓰는 캐릭터를 지울까요? (목록에는 남아있어요)')) return;
    S.activeCharId = null; persistChars();
    renderSetupChar(); updateSetupTabChecks(); refreshMain();
  });
}

/* 캐릭터 초안 저장: [저장하고 닫기]를 누르면 초안이 있으면 저장 */
function saveCharDraft() {
  if (!S.charDraft) { alert('먼저 [캐릭터 그리기]를 눌러주세요.'); return; }
  const c = { id: 'c' + Date.now(), dataUrl: S.charDraft, desc: S.charDraftDesc || $('char-desc').value.trim() };
  S.chars.push(c); S.activeCharId = c.id; persistChars();
  S.charDraft = null; S.charDraftDesc = null;
  $('char-preview-wrap').hidden = true;
  renderSetupChar(); updateSetupTabChecks(); refreshMain();
}

/* ---------- 메인 화면 ---------- */
function prepsDone() {
  return !!(S.name && S.code && activeChar());
}
function refreshMain() {
  const doneAcct = !!S.name, doneCode = !!S.code, doneChar = !!activeChar();
  const set = (id, label, d) => {
    $(id).querySelector('.pill-label').textContent = (d ? '✅ ' : '') + label;
    $(id).classList.toggle('done', d);
  };
  set('pill-acct', '1. 내 계정 알려주기', doneAcct);
  set('pill-code', '2. 입장코드 넣기', doneCode);
  set('pill-char', '3. 캐릭터 정하기', doneChar);
  const all = doneAcct && doneCode && doneChar;
  $('setup-sub').textContent = all ? '준비 완료!' : '설정이 필요해요';
  $('btn-main-topics').disabled = !all;
  $('prep-need').hidden = all;
}

function buildShapeGrid() {
  const w = $('shape-grid');
  w.innerHTML = '';
  SHAPES.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'shape-card' + (S.shape && S.shape.key === s.key ? ' sel' : '');
    const l = document.createElement('div'); l.className = 'shape-label'; l.textContent = s.label;
    const sub = document.createElement('div'); sub.className = 'shape-sub'; sub.textContent = s.sub;
    b.append(l, sub);
    b.onclick = () => { S.shape = s; buildShapeGrid(); };
    w.appendChild(b);
  });
}

function initMain() {
  $$('.pill-go').forEach((b) => b.addEventListener('click', () => openSetup(b.dataset.go)));
  $$('.opt-card').forEach((b) => b.addEventListener('click', () => {
    S.src = b.dataset.src;
    $$('.opt-card').forEach((x) => x.classList.toggle('sel', x === b));
    $('src-link-panel').hidden = S.src !== 'link';
    $('src-direct-panel').hidden = S.src !== 'direct';
  }));
  on('btn-main-topics', 'click', async () => {
    if (!S.apiKey) return needKey();
    if (S.src === 'link') { $('src-link-panel').hidden = false; return; }
    if (S.src === 'direct') { $('src-direct-panel').hidden = false; return; }
    showView('view-topics');
    await fetchTopics();
  });
  on('btn-link-go', 'click', async () => {
    if (!S.apiKey) return needKey();
    const url = $('in-link').value.trim();
    if (!url) { alert('링크를 입력하세요.'); return; }
    const btn = $('btn-link-go');
    btn.disabled = true; btn.textContent = '분석 중...';
    try {
      const t = await geminiText(PROMPT_LINK(url));
      const j = parseJsonLoose(t);
      if (!j.title) throw new Error('주제를 정리하지 못했어요');
      S.topic = { format: '🔗 링크', title: j.title, desc: j.desc || '', hook: '', reason: '' };
      await gotoSummary();
    } catch (e) { alert('링크 분석 실패: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '분석해서 만들기'; }
  });
  on('btn-direct-go', 'click', async () => {
    if (!S.apiKey) return needKey();
    const v = $('in-direct-topic').value.trim();
    if (!v) { alert('주제를 적어주세요.'); return; }
    S.topic = { format: '✍️ 직접 입력', title: v, desc: '', hook: '', reason: '' };
    await gotoSummary();
  });
  on('btn-back-main', 'click', () => showView('view-main'));
}

/* ---------- 주제 추천 ---------- */
function renderTopicCard(t) {
  const d = document.createElement('div');
  d.className = 'topic-card';
  const f = document.createElement('div'); f.className = 'topic-format'; f.textContent = t.format || '';
  const h = document.createElement('div'); h.className = 'topic-title'; h.textContent = t.title || '';
  const hook = document.createElement('div'); hook.className = 'topic-hook'; hook.textContent = t.hook ? '“' + t.hook + '”' : '';
  const p = document.createElement('div'); p.className = 'topic-desc'; p.textContent = t.reason || t.desc || '';
  const b = document.createElement('button'); b.className = 'topic-go'; b.textContent = '이걸로 만들기 →';
  d.append(f, h, hook, p, b);
  d.onclick = () => gotoSummary(t);
  $('topic-list').appendChild(d);
}

async function fetchTopics() {
  if (!S.apiKey) return needKey();
  const btn = $('btn-topics');
  btn.disabled = true; btn.textContent = '✨ 추천받는 중...';
  $('topic-list').innerHTML = '';
  try {
    const direction = $('src-direction').value.trim();
    const t = await geminiText(PROMPT_TOPICS(direction));
    const j = parseJsonLoose(t);
    const arr = (j.topics || []).slice(0, 5);
    if (!arr.length) throw new Error('추천을 받지 못했어요');
    arr.forEach(renderTopicCard);
  } catch (e) { alert('주제 추천 실패: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '✨ 주제 5개 추천받기'; }
}

function initTopics() {
  on('btn-topics', 'click', fetchTopics);
}

/* ---------- 요약 화면 ---------- */
async function gotoSummary(topic) {
  if (topic) S.topic = topic;
  if (!S.topic) return;
  showView('view-summary');
  $('sum-format').textContent = '';
  $('sum-title').textContent = S.topic.title;
  $('sum-reason').textContent = '형식 이유를 정리하고 있어요...';
  try {
    if (S.shape.key === 'ai') {
      const t = await geminiText(PROMPT_PICK_SHAPE(S.topic));
      const keys = SHAPES.filter((s) => s.key !== 'ai').map((s) => s.key);
      const k = keys.find((kk) => String(t).includes(kk));
      S.shape = SHAPES.find((s) => s.key === (k || 'tips'));
      buildShapeGrid();
    }
    $('sum-format').textContent = S.shape.label;
    $('sum-reason').textContent = await geminiText(PROMPT_SHAPE_REASON(S.topic, S.shape));
  } catch (e) {
    $('sum-reason').textContent = '이유를 가져오지 못했어요. 그래도 카드 만들기는 할 수 있어요.';
  }
}

function initSummary() {
  on('btn-back-topics', 'click', () => showView('view-topics'));
  on('btn-settings2', 'click', openSettings);
  /* 장수 선택 */
  $$('#pagecount-row .pc-btn').forEach((b) => {
    b.addEventListener('click', () => {
      S.pageCount = parseInt(b.dataset.n, 10) || 9;
      $$('#pagecount-row .pc-btn').forEach((x) => x.classList.toggle('on', x === b));
      $('btn-draw').textContent = `🎨 그림 ${S.pageCount}장 한 번에 그리기`;
    });
  });
  on('btn-draw', 'click', async () => {
    if (S.busy) return;
    S.busy = true;
    $('sum-loading').hidden = false;
    const btn = $('btn-draw');
    btn.disabled = true;
    try {
      await buildCards();
    } finally {
      S.busy = false;
      btn.disabled = false;
      $('sum-loading').hidden = true;
    }
  });
}

/* ---------- 카드 구성 생성 ---------- */
async function buildCards() {
  const n = S.pageCount;
  const t = await geminiText(PROMPT_PLAN(S.topic, S.shape, n));
  const j = parseJsonLoose(t);
  const arr = (j.cards || []).slice(0, n);
  if (arr.length < n) throw new Error(n + '장 구성을 받지 못했어요');
  S.field = (j.field || '').slice(0, 6);
  S.cards = arr.map((c) => ({
    title: c.title || '', desc: c.desc || '', scene: c.scene || '',
    img: null, imgEl: null, bg: 'default', hlS: null, hlE: null, stamp: '', gen: false,
  }));
  S.page = 0;
  showView('view-editor');
  renderPage();
  generateCardImages(); // 백그라운드에서 순차 생성
}

/* 카드별 일러스트: 캐릭터 레퍼런스 img2img로 순차 생성 */
async function generateCardImages() {
  const bar = $('img-progress');
  bar.hidden = false;
  const ch = activeChar();
  for (let i = 0; i < S.cards.length; i++) {
    const card = S.cards[i];
    if (card.img) continue;
    card.gen = true;
    if (i === S.page) renderPreview();
    bar.textContent = `🖼 ${i + 1}번째 장 그림 그리는 중... (${i + 1}/${S.pageCount})`;
    try {
      const url = await geminiImage(imgPromptFor(card, i, ch), ch ? ch.dataUrl : null);
      card.img = await downscaleImage(url, 1080);
      card.imgEl = null;
    } catch (e) { card.img = null; /* 실패한 장은 나중에 [그림 다시 그리기] */ }
    card.gen = false;
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
  ['violet',  '보라', '#E4D9FF'],
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
  ctx.textBaseline = 'alphabetic';
  /* 위: 일러스트 */
  if (card.imgEl && card.imgEl.complete && card.imgEl.naturalWidth) {
    const iw = card.imgEl.naturalWidth, ih = card.imgEl.naturalHeight;
    const s = Math.max(CARD_W / iw, IMG_H / ih);
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(card.imgEl, (CARD_W - dw) / 2, (IMG_H - dh) / 2, dw, dh);
  } else if (card.gen) {
    ctx.fillStyle = '#151522';
    ctx.fillRect(0, 0, CARD_W, IMG_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 9;
    ctx.setLineDash([16, 13]);
    ctx.beginPath();
    ctx.arc(CARD_W / 2, IMG_H / 2 - 50, 48, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    ctx.font = '46px "Pretendard Variable", Pretendard, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('그림 그리는 중...', CARD_W / 2, IMG_H / 2 + 60);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, IMG_H);
    g.addColorStop(0, '#1e3a8a');
    g.addColorStop(1, '#3b82f6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CARD_W, IMG_H);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '46px "Pretendard Variable", Pretendard, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('그림 만들기 전', CARD_W / 2, IMG_H / 2);
  }

  /* 좌상단 카테고리 라벨: {표시이름} · {분야} */
  const nm = (S.name || '').trim();
  if (nm) {
    const label = S.field ? nm + ' · ' + S.field : nm;
    ctx.font = '700 34px "Pretendard Variable", Pretendard, sans-serif';
    const tw = ctx.measureText(label).width;
    const bx = 36, by = 30, bw = tw + 48, bh = 58;
    ctx.fillStyle = 'rgba(18,18,28,0.72)';
    roundRectPath(ctx, bx, by, bw, bh, 29);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + 24, by + bh / 2 + 2);
  }

  /* 우상단 도장 스탬프 */
  const stamp = (card.stamp || '').trim();
  if (stamp) {
    const cx = CARD_W - 128, cy = 148, r = 88;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.1);
    ctx.strokeStyle = '#e5484d';
    ctx.lineWidth = 11;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#e5484d';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (stamp.length <= 5) {
      ctx.font = '800 46px "Pretendard Variable", Pretendard, sans-serif';
      ctx.fillText(stamp, 0, 3);
    } else {
      ctx.font = '800 38px "Pretendard Variable", Pretendard, sans-serif';
      const mid = Math.ceil(stamp.length / 2);
      ctx.fillText(stamp.slice(0, mid), 0, -26);
      ctx.fillText(stamp.slice(mid), 0, 26);
    }
    ctx.restore();
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

function buildDots() {
  const w = $('page-dots');
  w.innerHTML = '';
  for (let i = 0; i < S.pageCount; i++) {
    const d = document.createElement('span');
    d.className = 'dot' + (i === S.page ? ' on' : '');
    w.appendChild(d);
  }
}

function renderPage() {
  const card = S.cards[S.page];
  if (!card) return;
  $('page-label').textContent = `${S.page + 1}번째 장 / ${S.pageCount}장`;
  buildDots();
  $('in-title').value = card.title;
  $('in-desc').value = card.desc;
  $('in-stamp').value = card.stamp || '';
  $('btn-prev').disabled = S.page === 0;
  $('btn-next').disabled = S.page === S.cards.length - 1;
  $('btn-redraw').textContent = card.img ? '🔄 그림 다시 그리기' : '🎨 이 장 그림 그리기';
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
    c.hlS = null; c.hlE = null;
    renderPreview();
  });
  on('in-desc', 'input', () => {
    const c = S.cards[S.page]; if (!c) return;
    c.desc = $('in-desc').value;
    renderPreview();
  });
  on('in-stamp', 'input', () => {
    const c = S.cards[S.page]; if (!c) return;
    c.stamp = $('in-stamp').value;
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
  const drawOne = async (btn) => {
    if (!S.apiKey) return needKey();
    const card = S.cards[S.page]; if (!card) return;
    const ch = activeChar();
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '그리는 중...';
    card.gen = true; renderPreview();
    try {
      const url = await geminiImage(imgPromptFor(card, S.page, ch), ch ? ch.dataUrl : null);
      card.img = await downscaleImage(url, 1080);
      card.imgEl = null;
    } catch (e) { alert('그리기 실패: ' + e.message); }
    card.gen = false;
    btn.disabled = false; btn.textContent = old;
    renderPage();
  };
  on('btn-redraw', 'click', (e) => drawOne(e.currentTarget));
  on('btn-use-photo', 'click', () => $('file-card-photo').click());
  on('file-card-photo', 'change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const card = S.cards[S.page]; if (!card) return;
    try {
      const url = await readFileAsDataURL(f);
      card.img = await downscaleImage(url, 1080);
      card.imgEl = null;
      renderPage();
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
      a.download = `캐릭터카드뉴스-${S.cards.length}장.zip`;
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
  on('btn-settings', 'click', openSettings);
  on('btn-close-settings', 'click', () => { $('settings-modal').hidden = true; });
  on('btn-save-key', 'click', () => {
    saveApiKey($('api-key').value);
    $('settings-modal').hidden = true;
    alert('저장됐어요.');
  });
  on('btn-save-key-main', 'click', () => {
    const v = $('api-key-main').value.trim();
    if (!v) { alert('키를 입력해주세요.'); return; }
    saveApiKey(v);
    alert('저장됐어요.');
  });
  $('api-key-main').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-save-key-main').click(); });
  on('btn-change-key', 'click', () => {
    $('api-key-main').value = S.apiKey;
    $('key-input-row').hidden = false;
    $('key-done-row').hidden = true;
    $('key-box').classList.remove('done');
    $('api-key-main').focus();
  });
  initSetup();
  buildShapeGrid();
  refreshKeyBox();
  initMain();
  initTopics();
  initSummary();
  initEditor();
  refreshMain();
  showView('view-main');
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (!$('view-editor').hidden) renderPreview(); });
  }
}
init();

(() => {
  'use strict';
  const groups = JSON.parse(document.querySelector('#packing-data').textContent);
  const key = 'chongqing-packing-v1';
  let packed = {};
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) packed = saved;
  } catch { /* The checklist remains usable for this visit. */ }
  const counters = [];
  const allInputs = [];

  function updateProgress() {
    const done = allInputs.filter(input => input.checked).length;
    document.querySelector('#packing-progress').textContent = `已装好 ${done} / ${allInputs.length} 项`;
    for (const { node, inputs } of counters) {
      node.textContent = inputs.filter(input => input.checked).length + ' / ' + inputs.length;
    }
  }

  const container = document.querySelector('#packing-groups');
  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'packing-bag';
    const heading = document.createElement('h3');
    heading.textContent = group.name;
    const counter = document.createElement('span');
    counter.className = 'packing-count';
    heading.append(counter);
    const subtitle = document.createElement('p');
    subtitle.className = 'note';
    subtitle.textContent = group.subtitle;
    const list = document.createElement('div');
    list.className = 'packing-items';
    const inputs = [];
    for (const [id, name, description] of group.items) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'packing-' + id;
      input.checked = packed[id] === true;
      input.addEventListener('change', () => {
        packed[id] = input.checked;
        try { localStorage.setItem(key, JSON.stringify(packed)); }
        catch { document.querySelector('#packing-save-status').textContent = '此浏览器暂不能保存，这次打开期间仍可勾选。'; }
        window.CQSync?.changed();
        label.classList.toggle('is-packed', input.checked);
        updateProgress();
      });
      const text = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = name;
      const detail = document.createElement('small');
      detail.textContent = description;
      text.append(title, detail);
      label.classList.toggle('is-packed', input.checked);
      label.append(input, text);
      list.append(label);
      inputs.push(input);
      allInputs.push(input);
    }
    counters.push({ node: counter, inputs });
    section.append(heading, subtitle, list);
    container.append(section);
  }
  window.CQSync?.register('packing', () => ({...packed}), next => {
    packed = next;
    try { localStorage.setItem(key, JSON.stringify(packed)); } catch {}
    for (const input of allInputs) {
      input.checked = packed[input.id.slice('packing-'.length)] === true;
      input.closest('label').classList.toggle('is-packed', input.checked);
    }
    updateProgress();
  });
  updateProgress();
})();

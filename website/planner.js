(() => {
  'use strict';
  const select = (s, root = document) => root.querySelector(s);
  const { places, dates, areas, slots, rankings, meals } = JSON.parse(select('#planner-data').textContent);
  const byId = new Map(places.map(place => [place.id, place]));
  const byDay = new Map(dates.map(day => [day.id, day]));
  const key = 'chongqing-daily-plans-v1';
  const defaults = Object.fromEntries(dates.map(day => [day.id, Object.fromEntries(
    day.defaults.map(id => [id, { slot: day.defaultSlots?.[id] || byId.get(id).slot, active: true }])
  )]));
  let plan = { day: dates[0].id, days: defaults, history: [] };
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved?.days && byDay.has(saved.day) && Array.isArray(saved.history)) plan = saved;
  } catch { /* The proposed itinerary still works when storage is unavailable. */ }
  if (!plan.position || typeof plan.position !== 'object' || Array.isArray(plan.position)) {
    plan.position = {};
  }

  const tripMapNode = select('#day-map');
  const discoverMapNode = select('#explore-map');
  const dialog = select('#place-dialog');
  const dateInput = select('#place-date');
  const slotInput = select('#place-slot');
  const camera = select('#shooting');
  const cameraViewer = select('#shoot-viewer');
  let currentPlace, opener;
  let placePhotoIndex = 0;
  let cameraKey, cameraPhotos = [], cameraIndex = 0;
  let area = 'all', rank = 'morning', catalogFilter = 'all';
  const cityView = [29.558, 106.542];
  const previewZoom = 16;

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function button(content, handler, className) {
    const node = element('button', className, content);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }
  function link(content, url) {
    const node = element('a', '', content);
    node.href = url;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    return node;
  }
  function persist() {
    try { localStorage.setItem(key, JSON.stringify(plan)); }
    catch { select('#plan-status').textContent = '当前浏览器无法保存，刷新后将恢复建议路线。'; }
    window.CQSync?.changed();
  }
  function entries(day = plan.day) {
    return Object.entries(plan.days[day] || {}).filter(([id, item]) => byId.has(id) && slots[item.slot]);
  }
  function activeStop() {
    const id = plan.position[plan.day];
    return plan.days[plan.day]?.[id]?.active ? byId.get(id) : undefined;
  }
  function mapLink(query) {
    return `https://uri.amap.com/search?keyword=${encodeURIComponent(query)}&city=${encodeURIComponent('重庆')}&callnative=0`;
  }

  function renderStay() {
    const hotel = byId.get(plan.stay);
    const summary = select('#stay-choice');
    summary.replaceChildren();
    if (hotel?.kind !== 'hotel') {
      summary.append(element('p', '', '还没选住宿。先比较观音桥、南坪、冉家坝周边的6家新增候选。'));
      return;
    }
    summary.append(element('strong', '', hotel.name), element('p', 'note',
      '12月5日入住—7日退房 · 两晚候选 · ' + hotel.address));
    const details = button('查看住宿详情', () => showPlace(hotel, details), 'plan-button');
    const clear = button('取消住宿候选', () => {
      delete plan.stay;
      persist();
      renderStay();
    }, 'schedule-open');
    summary.append(details, clear);
  }

  function renderMeals() {
    const container = select('#meal-suggestions');
    container.replaceChildren();
    const choices = meals?.[plan.day] || [];
    if (!choices.length) return;
    container.append(element('h4', '', '顺路吃饭候选'));
    const list = element('div', 'meal-options');
    for (const id of choices) {
      const place = byId.get(id);
      if (!place) continue;
      const open = button(place.name, () => showPlace(place, open), 'plan-button');
      list.append(open);
    }
    container.append(list, element('p', 'note', '先看门店和评价，再在详情里加入当天。每顿挑一家即可。'));
  }

  function renderVisit() {
    const box = select('#place-visit');
    const info = currentPlace.visitInfo;
    box.replaceChildren();
    if (!info) return;
    box.append(element('h3', '', currentPlace.kind === 'hotel' ? '入住和到达' : '去之前看一眼'));
    const list = element('dl', 'visit-facts');
    for (const [key, label] of [['address','地址'], ['fee','门票 / 消费'], ['reservation','预约 / 排号'],
      ['hours','开放 / 营业'], ['entry','入口与提醒']]) {
      if (info[key]) list.append(element('dt', '', label), element('dd', '', info[key]));
    }
    box.append(list);
    if (info.mondayClosed && dateInput.value === '07') {
      box.append(element('p', 'visit-warning', '12月7日是周一，这处室内场馆按常规闭馆安排。请换至5日或6日，并临行再核对公告。'));
    }
    const sources = element('div', 'place-links');
    for (const item of info.sources || []) sources.append(link(item.label + ' ↗', item.url));
    box.append(sources, element('p', 'note', `资料复核于${info.checked || '2026-11-11'}。临时检修、活动和限流仍以当天公告为准。`));
  }

  function renderReviews() {
    const box = select('#place-reviews');
    box.replaceChildren();
    const review = currentPlace.review;
    box.hidden = !review;
    if (!review) return;
    box.append(element('h3', '', currentPlace.kind === 'hotel' ? '住客评价与取舍' : '帖子里怎么说'));
    if (review.rating) box.append(element('p', 'review-rating', '携程页面快照 · ' + review.rating));
    box.append(element('p', '', review.positive), element('p', 'review-caution', review.caution),
      element('p', 'note', review.scope));
  }

  function showPlacePhoto() {
    const photo = currentPlace.photos[placePhotoIndex];
    const viewer = select('#place-photo-viewer');
    viewer.hidden = !photo;
    if (!photo) {
      select('#place-image').removeAttribute('src');
      return;
    }
    for (const selector of ['#place-image', '#place-zoom-image']) {
      const image = select(selector);
      image.src = photo.src;
      image.alt = currentPlace.name + ' · ' + photo.label;
    }
    const count = (placePhotoIndex + 1) + ' / ' + currentPlace.photos.length;
    select('#place-photo-count').textContent = count;
    select('#place-zoom-count').textContent = count;
    select('#place-photo-source').replaceChildren(link(photo.label + ' · 原帖 ↗', photo.url));
    select('#place-zoom-title').textContent = currentPlace.name;
    for (const selector of ['#place-photo-prev', '#place-photo-next', '#place-zoom-prev', '#place-zoom-next']) {
      select(selector).hidden = currentPlace.photos.length < 2;
    }
  }

  function changePlacePhoto(delta) {
    if (!currentPlace?.photos.length) return;
    placePhotoIndex = (placePhotoIndex + delta + currentPlace.photos.length) % currentPlace.photos.length;
    showPlacePhoto();
  }

  function showCameraPhoto() {
    const photo = cameraPhotos[cameraIndex];
    if (!photo) return;
    const image = select('#shoot-image');
    image.src = photo.src;
    image.alt = photo.caption;
    select('#shoot-caption').textContent = photo.caption;
    select('#shoot-tip').textContent = photo.tip;
    select('#shoot-count').textContent = `${cameraIndex + 1} / ${cameraPhotos.length}`;
    select('#shoot-credit').replaceChildren(link(photo.label + ' ↗', photo.url));
  }
  function changeCameraPhoto(offset) {
    if (cameraPhotos.length < 2) return;
    cameraIndex = (cameraIndex + offset + cameraPhotos.length) % cameraPhotos.length;
    showCameraPhoto();
  }
  function renderCamera() {
    const place = activeStop();
    select('#shoot-empty').hidden = !!place;
    select('#shoot-active').hidden = !place;
    if (!place) {
      cameraKey = undefined;
      cameraPhotos = [];
      select('#shoot-image').removeAttribute('src');
      return;
    }
    const detail = place.shooting;
    const nextKey = `${plan.day}/${place.id}`;
    if (cameraKey !== nextKey) cameraIndex = 0;
    cameraKey = nextKey;
    cameraPhotos = detail?.photos || [];
    select('#shoot-title').textContent = place.name;
    select('#shoot-date').textContent = byDay.get(plan.day).label + ' · 当前位置';
    select('#shoot-address').textContent = detail?.address ||
      (place.coords ? `重庆市 · ${areas[place.area]} · ${place.name}` : '请按所选门店核对门牌');
    select('#shoot-access').textContent = detail?.access ||
      '用下方导航核对这个地点的入口或当天所选门店。';
    select('#shoot-note').textContent = detail?.note ||
      '这处地点的具体站位和参考图还未核对。';
    const nav = select('#shoot-nav');
    nav.replaceChildren(link('用高德找这个地点 ↗', mapLink(detail?.query || place.name.split(' · ')[0])));
    if (detail?.source) nav.append(link(detail.source.label + ' ↗', detail.source.url));
    cameraViewer.hidden = !cameraPhotos.length;
    select('#shoot-prev').hidden = cameraPhotos.length < 2;
    select('#shoot-next').hidden = cameraPhotos.length < 2;
    if (cameraPhotos.length) showCameraPhoto();
    else select('#shoot-image').removeAttribute('src');
  }
  function selectStop(id) {
    if (!plan.days[plan.day]?.[id]?.active) return;
    plan.position[plan.day] = id;
    for (const control of document.querySelectorAll('[data-current-stop]')) {
      const selected = control.dataset.currentStop === id;
      control.setAttribute('aria-pressed', String(selected));
      control.textContent = selected ? '当前位置 · 看机位' : '我在这里';
      control.setAttribute('aria-label', byId.get(control.dataset.currentStop).name +
        (selected ? ' · 查看当前位置机位' : ' · 我在这里'));
      control.closest('.schedule-row').classList.toggle('at-stop', selected);
    }
    if (tripMap) drawMarkers(tripMap);
    renderCamera();
    persist();
    camera.scrollIntoView({ behavior: 'instant', block: 'start' });
    select('#shoot-title').focus({ preventScroll: true });
  }
  function changePlan(day, id, slot, active) {
    const items = plan.days[day] ??= {};
    const prev = items[id];
    if (prev?.active === active && prev.slot === slot) return false;
    items[id] = { slot, active };
    if (!active && plan.position[day] === id) delete plan.position[day];
    plan.history.unshift({ day, id, active, slot, moved: !!prev?.active && active, at: Date.now() });
    plan.history = plan.history.slice(0, 30);
    renderDay();
    if (catalogFilter === 'saved') renderCatalog();
    persist();
    return true;
  }

  function initMap(node) {
    if (!window.L) return null;
    const map = L.map(node, { scrollWheelZoom: false, fadeAnimation: false, zoomAnimation: false, minZoom: 10, maxZoom: 18 }).setView(cityView, 12);
    map.attributionControl.setPrefix(false);
    const caption = node.parentElement.querySelector('.map-service');
    const retry = button('重试底图', () => { failed = false; tiles?.redraw(); }, 'map-retry');
    retry.hidden = true;
    caption.insertAdjacentElement('afterend', retry);
    let tiles, timeout, failed = false;
    const loadedVisibleTiles = () => {
      const box = node.getBoundingClientRect();
      return [...node.querySelectorAll('.leaflet-tile')].filter(tile => {
        const r = tile.getBoundingClientRect();
        return tile.complete && tile.naturalWidth > 0 && r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
      }).length;
    };
    const unavailable = () => {
      failed = true; retry.hidden = false;
      caption.textContent = loadedVisibleTiles()
        ? '底图部分区域未加载。可重试底图；地点详情和导航仍可使用。'
        : '地图底图未能加载，当前位置标记不代表道路。请重试底图，或从地点列表打开详情和导航。';
      node.classList.add('map-load-warning');
    };
    if (!window.CQ_OFFLINE) {
      caption.textContent = '正在加载地图底图…';
      tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxNativeZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      });
      tiles.on('loading', () => {
        failed = false; clearTimeout(timeout);
        timeout = setTimeout(() => { if (!loadedVisibleTiles()) unavailable(); }, 8000);
      });
      tiles.on('tileerror', event => {
        event.tile.style.visibility = 'hidden';
        unavailable();
      });
      tiles.on('tileload', () => {
        if (!failed) {
          caption.textContent = '放大查看代表图。密集地点会合并显示，点开可逐个查看。';
          retry.hidden = true; node.classList.remove('map-load-warning');
        }
      });
      tiles.on('load', () => {
        clearTimeout(timeout);
        if (!loadedVisibleTiles()) unavailable();
      });
      tiles.addTo(map);
    } else caption.textContent = '离线版没有道路底图。可点地点标记或下方地点列表，打开详情和导航。';
    const instance = { map, layer: L.layerGroup().addTo(map), points: [], overview: node === discoverMapNode, fitted: false, signature: '' };
    map.on('zoomend', () => drawMarkers(instance));
    if (typeof ResizeObserver === 'function') {
      let lastWidth = 0, lastHeight = 0, scheduled;
      instance.resizeObserver = new ResizeObserver(() => {
        const width = node.clientWidth, height = node.clientHeight;
        if (!width || !height || width === lastWidth && height === lastHeight) return;
        lastWidth = width; lastHeight = height;
        cancelAnimationFrame(scheduled);
        scheduled = requestAnimationFrame(() => {
          map.invalidateSize({ pan: false, debounceMoveend: true });
          drawMarkers(instance);
        });
      });
      instance.resizeObserver.observe(node);
    }
    return instance;
  }
  let tripMap, discoverMap;

  function drawMarkers({ map, layer, points, overview }) {
    layer.clearLayers();
    const zoom = map.getZoom();
    const here = overview ? undefined : activeStop()?.id;
    const groups = [];
    points.forEach((place, i) => {
      const position = map.project(place.coords);
      const group = groups.find(item => item.position.distanceTo(position) < (zoom >= previewZoom ? 86 : 38));
      if (group) group.items.push({ place, i });
      else groups.push({ position, items: [{ place, i }] });
    });
    for (const { items } of groups) {
      const [{ place, i }] = items;
      if (items.length > 1) {
        const center = L.latLngBounds(items.map(item => item.place.coords)).getCenter();
        const cluster = L.marker(center, {
          title: items.map(item => item.place.name).join('、'),
          alt: `放大查看附近 ${items.length} 个景点`,
          icon: L.divIcon({ className: 'city-pin city-cluster', html: `${items.length}处`, iconSize: [37, 37], iconAnchor: [18, 18] })
        }).addTo(layer);
        if (zoom >= previewZoom && place.photos[0]) {
          const preview = element('div', 'pin-preview');
          const image = element('img'); image.src = place.photos[0].src;
          image.alt = `附近${items.length}处地点代表图`;
          preview.append(image, element('span', '', `附近${items.length}处`));
          cluster.setIcon(L.divIcon({ className: 'city-photo-pin city-photo-cluster', html: preview, iconSize: [74,62], iconAnchor: [37,62] }));
        }
        cluster.on('click', () => {
          if (map.getZoom() < map.getMaxZoom()) {
            map.setView(center, Math.min(map.getMaxZoom(), map.getZoom() + 2));
            return;
          }
          const list = element('div', 'map-nearby-list');
          list.append(element('strong', '', `附近${items.length}处地点`));
          for (const { place: nearby } of items) {
            const choice = button('', () => { map.closePopup(); showPlace(nearby, cluster.getElement()); }, 'map-nearby-choice');
            if (nearby.photos[0]) {
              const image = element('img'); image.src = nearby.photos[0].src; image.alt = nearby.name;
              choice.append(image);
            }
            choice.append(element('span', '', nearby.name)); list.append(choice);
          }
          L.popup({ maxWidth: 280 }).setLatLng(center).setContent(list).openOn(map);
        });
        continue;
      }
      const photo = place.photos[0];
      const selectedClass = here === place.id ? ' map-current' : '';
      let icon = L.divIcon({ className: 'city-pin' + selectedClass, html: String(i + 1), iconSize: [28, 28], iconAnchor: [14, 14] });
      if (zoom >= previewZoom && photo) {
        const preview = element('div', 'pin-preview');
        const image = element('img');
        image.src = photo.src;
        image.alt = place.name + '代表图';
        image.loading = 'lazy';
        preview.append(image, element('span', '', place.name));
        icon = L.divIcon({ className: 'city-photo-pin' + selectedClass, html: preview, iconSize: [74, 62], iconAnchor: [37, 62] });
      }
      const marker = L.marker(place.coords, {
        title: place.name,
        alt: place.name,
        icon
      }).addTo(layer);
      marker.on('click', () => showPlace(place, marker.getElement()));
    }
  }

  function plot(instance, placesToPlot, indexNode) {
    indexNode.replaceChildren();
    placesToPlot.forEach((place, i) => {
      const indexButton = button(`${i + 1} · ${place.name}`, () => showPlace(place, indexButton));
      indexNode.append(indexButton);
    });
    if (!instance) return;
    const { map } = instance;
    instance.points = placesToPlot;
    if (!map.getContainer().getClientRects().length) return;
    map.invalidateSize({ pan: false });
    const signature = placesToPlot.map(place => place.id).join('|');
    if (!instance.fitted || instance.signature !== signature) {
      if (placesToPlot.length === 1) map.setView(placesToPlot[0].coords, 15);
      else if (placesToPlot.length) map.fitBounds(placesToPlot.map(place => place.coords), { padding: [50, 50], maxZoom: 15, animate: false });
      else map.setView(cityView, 12);
      instance.fitted = true; instance.signature = signature;
    }
    drawMarkers(instance);
  }

  function renderRouteGuide(day) {
    const host = select('#day-route-guide');
    if (!host) return;
    host.replaceChildren();
    if (!day.timeline?.length) return;
    const intro = element('p', 'note', '这是更新后的路线建议。你已保存的勾选不会自动改动；采用时只替换这天的景点，餐饮与住宿候选保留。');
    const apply = button('采用这天建议', () => {
      const wanted = new Set(day.defaults);
      const items = plan.days[day.id] ||= {};
      const at = Date.now();
      for (const [id, item] of Object.entries(items)) {
        const place = byId.get(id);
        if (place && (place.kind === 'sight' || place.kind === 'experience' || (place.coords && place.area !== 'food' && place.kind !== 'hotel')) && item.active && !wanted.has(id)) {
          item.active = false;
          plan.history.unshift({day:day.id,id,active:false,slot:item.slot,at});
        }
      }
      for (const id of wanted) {
        const slot = day.defaultSlots?.[id] || byId.get(id).slot;
        items[id] = {slot,active:true};
        plan.history.unshift({day:day.id,id,active:true,slot,at});
      }
      if (plan.position[day.id] && !items[plan.position[day.id]]?.active) delete plan.position[day.id];
      plan.history = plan.history.slice(0,30);
      persist(); renderDay();
      select('#day-title').focus({preventScroll:true});
    }, 'plan-button');
    const plannedSights = entries(day.id).filter(([id,item]) => item.active &&
      (byId.get(id).kind === 'sight' || byId.get(id).kind === 'experience' || (byId.get(id).coords && byId.get(id).area !== 'food' && byId.get(id).kind !== 'hotel')));
    const matches = plannedSights.length === day.defaults.length && day.defaults.every(id =>
      plan.days[day.id]?.[id]?.active && plan.days[day.id][id].slot === (day.defaultSlots?.[id] || byId.get(id).slot));
    apply.disabled = matches;
    if (matches) apply.textContent = '已按这版建议安排';
    const list = element('ol', 'route-timeline');
    for (const stop of day.timeline) {
      const row = element('li');
      row.append(element('span', 'route-time', stop.time), element('strong', '', stop.title), element('p', '', stop.detail));
      list.append(row);
    }
    host.append(intro,apply,list);
  }

  function renderDay() {
    const day = byDay.get(plan.day);
    const stop = activeStop();
    select('#day-title').textContent = day.title;
    select('#day-context').textContent = day.context;
    renderRouteGuide(day);
    document.querySelectorAll('[data-plan-day]').forEach(node => {
      node.setAttribute('aria-pressed', String(node.dataset.planDay === day.id));
    });
    const rows = entries();
    const active = rows.filter(([, item]) => item.active);
    const sights = Object.keys(slots).flatMap(slot => active.filter(([id, item]) =>
      item.slot === slot && byId.get(id).coords).map(([id]) => byId.get(id)));
    select('#day-count').textContent = `已勾选 ${active.length} 项 · 地图 ${sights.length} 个景点`;
    select('#day-empty').hidden = !!sights.length;
    if (!select('#panel-trip').hidden) tripMap ??= initMap(tripMapNode);
    plot(tripMap, sights, select('#day-index'));

    const schedule = select('#day-schedule');
    schedule.replaceChildren();
    for (const [slot, label] of Object.entries(slots)) {
      const group = element('div', 'schedule-group');
      group.append(element('h4', '', label));
      const note = day.notes[slot];
      if (note) group.append(element('p', 'note', note));
      for (const [id, item] of rows.filter(([, value]) => value.slot === slot)) {
        const place = byId.get(id);
        const row = element('div', 'schedule-row');
        const input = element('input');
        input.type = 'checkbox';
        input.id = `plan-${day.id}-${id}`;
        input.checked = item.active;
        input.addEventListener('change', () => {
          const target = input.id;
          changePlan(day.id, id, slot, input.checked);
          document.getElementById(target)?.focus({ preventScroll: true });
        });
        const title = element('label', '', place.name);
        title.htmlFor = input.id;
        title.append(element('small', '', place.short));
        const detail = button('详情', () => showPlace(place, detail), 'schedule-open');
        detail.setAttribute('aria-label', `查看${place.name}详情`);
        const actions = element('div', 'schedule-actions');
        actions.append(detail);
        if (item.active) {
          const selected = stop?.id === id;
          const position = button(selected ? '当前位置 · 看机位' : '我在这里',
            () => selectStop(id), 'schedule-position');
          position.dataset.currentStop = id;
          position.setAttribute('aria-pressed', String(selected));
          position.setAttribute('aria-label', `${place.name} · ${selected ? '查看当前位置机位' : '我在这里'}`);
          row.classList.toggle('at-stop', selected);
          actions.append(position);
        }
        row.append(input, title, actions);
        group.append(row);
      }
      if (group.children.length > 1) schedule.append(group);
    }
    if (!schedule.children.length) schedule.append(element('p', 'note', '当天还没有安排，可以从推荐页加入。'));

    const history = select('#plan-history-list');
    history.replaceChildren();
    for (const event of plan.history.slice(0, 12)) {
      if (!byId.has(event.id) || !byDay.has(event.day)) continue;
      const time = new Date(event.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      const verb = event.moved ? '调整为' : event.active ? '加入' : '取消';
      history.append(element('li', '', `${time} · ${byDay.get(event.day).label} ${verb} ${byId.get(event.id).name}${event.active ? ' · ' + slots[event.slot] : ''}`));
    }
    if (!history.children.length) history.append(element('li', '', '还没有改动。'));
    renderMeals();
    renderStay();
    renderCamera();
  }

  function renderExplore() {
    if (select('#panel-discover').hidden) return;
    discoverMap ??= initMap(discoverMapNode);
    const sights = places.filter(place => place.coords && (area === 'all' || place.area === area));
    select('#explore-count').textContent = `${sights.length} 个景点`;
    document.querySelectorAll('[data-plan-area]').forEach(node => {
      node.setAttribute('aria-pressed', String(node.dataset.planArea === area));
    });
    plot(discoverMap, sights, select('#explore-index'));
  }

  function renderRank() {
    document.querySelectorAll('[data-plan-rank]').forEach(node => {
      node.setAttribute('aria-pressed', String(node.dataset.planRank === rank));
    });
    const list = select('#rank-list');
    list.replaceChildren();
    rankings[rank].forEach(([id, reason], i) => {
      const place = byId.get(id);
      const item = element('li');
      const open = button('', () => showPlace(place, open), 'rank-entry');
      const number = element('span', 'rank-number', String(i + 1).padStart(2, '0'));
      const thumb = place.photos[0] ? element('img') : element('span', 'rank-thumb', place.coords ? '景点' : '餐厅');
      if (place.photos[0]) {
        thumb.src = place.photos[0].src;
        thumb.alt = '';
        thumb.loading = 'lazy';
      }
      const content = element('span');
      content.append(element('strong', '', place.name), element('small', '', reason));
      open.append(number, thumb, content);
      item.append(open);
      list.append(item);
    });
  }

  function renderCatalog() {
    const catalog = select('#full-catalog');
    if (!catalog) return;
    const activeIds = new Set(dates.flatMap(day => entries(day.id).filter(([, item]) => item.active).map(([id]) => id)));
    const visible = places.filter(place => catalogFilter === 'all' ||
      (catalogFilter === 'walk' && (place.coords || place.kind === 'sight' || place.kind === 'experience')) ||
      (catalogFilter === 'food' && !place.coords && place.area === 'food') ||
      (catalogFilter === 'hotel' && place.kind === 'hotel') ||
      (catalogFilter === 'saved' && activeIds.has(place.id)));
    catalog.replaceChildren();
    for (const [id, label] of [...Object.entries(areas), ['food', '餐厅与小吃'], ['hotel', '新增两晚住宿候选']]) {
      const list = visible.filter(place => place.area === id);
      if (!list.length) continue;
      const section = element('section', 'catalog-group');
      const heading = element('h3', '', `${label} · ${list.length} 项`);
      const grid = element('div', 'catalog-grid');
      for (const place of list) {
        const open = button('', () => showPlace(place, open), 'catalog-entry');
        const image = place.photos[0];
        if (image) {
          const thumb = element('img');
          thumb.src = image.src;
          thumb.alt = '';
          thumb.loading = 'lazy';
          open.append(thumb);
        }
        const content = element('span', 'catalog-info');
        content.append(element('strong', '', place.name), element('small', '', place.short));
        open.append(content);
        grid.append(open);
      }
      section.append(heading, grid);
      catalog.append(section);
    }
    catalog.hidden = !visible.length;
    if (visible.length) select('#empty').hidden = true;
    else if (catalogFilter === 'saved') select('#empty').hidden = !!select('.recommend-card:not([hidden])');
  }

  function updatePlaceButton() {
    const item = plan.days[dateInput.value]?.[currentPlace.id];
    const save = select('#place-save');
    save.textContent = item?.active && item.slot === slotInput.value ? '取消这天的安排' :
      item?.active ? '更新当天时段' : '加入这天行程';
  }
  function showPlace(place, source) {
    currentPlace = place;
    opener = source;
    select('#place-title').textContent = place.name;
    select('#place-meta').textContent = `${place.region || areas[place.area] || (place.kind === 'hotel' ? '住哪里' : '吃什么')} · ${place.visit}`;
    select('#place-description').textContent = place.description;
    select('#place-tip').textContent = place.tip || '';
    select('#place-feedback').textContent = '';
    placePhotoIndex = 0;
    showPlacePhoto();
    const links = select('#place-links');
    links.replaceChildren(...place.sources.map(({label, url}) => link(label + ' ↗', url)));
    const destination = place.query || place.shooting?.query || place.name.split(' · ')[0];
    links.append(link('高德地图搜地点 ↗', mapLink(destination)));
    dateInput.value = plan.day;
    slotInput.value = plan.days[plan.day]?.[place.id]?.slot || place.slot;
    select('#place-plan-fields').hidden = place.kind === 'hotel';
    select('#place-stay-save').hidden = place.kind !== 'hotel';
    select('#place-stay-save').textContent = plan.stay === place.id ? '取消这家住宿候选' : '选为12月5—7日两晚住宿候选';
    if (place.kind !== 'hotel') updatePlaceButton();
    renderVisit();
    renderReviews();
    dialog.showModal();
    dialog.scrollTop = 0;
  }
  dateInput.addEventListener('change', () => {
    slotInput.value = plan.days[dateInput.value]?.[currentPlace.id]?.slot || currentPlace.slot;
    select('#place-feedback').textContent = '';
    updatePlaceButton();
    renderVisit();
  });
  slotInput.addEventListener('change', updatePlaceButton);
  select('#place-save').addEventListener('click', () => {
    const date = dateInput.value;
    const slot = slotInput.value;
    const previous = plan.days[date]?.[currentPlace.id];
    const active = !(previous?.active && previous.slot === slot);
    changePlan(date, currentPlace.id, slot, active);
    select('#place-feedback').textContent = `${byDay.get(date).label}${active ? '已加入或更新' : '已取消'} · ${currentPlace.name}`;
    updatePlaceButton();
  });
  select('#place-stay-save').addEventListener('click', () => {
    if (currentPlace?.kind !== 'hotel') return;
    const selected = plan.stay !== currentPlace.id;
    if (selected) plan.stay = currentPlace.id;
    else delete plan.stay;
    persist();
    renderStay();
    select('#place-stay-save').textContent = selected ? '取消这家住宿候选' : '选为12月5—7日两晚住宿候选';
    select('#place-feedback').textContent = selected ? '已记入两晚住宿候选，可从行程笔记查看。预订需另在酒店渠道完成。' : '已取消这家住宿候选。';
  });
  select('#place-photo-prev').addEventListener('click', () => changePlacePhoto(-1));
  select('#place-photo-next').addEventListener('click', () => changePlacePhoto(1));
  select('#place-zoom-prev').addEventListener('click', () => changePlacePhoto(-1));
  select('#place-zoom-next').addEventListener('click', () => changePlacePhoto(1));
  select('#place-photo-open').addEventListener('click', () => select('#place-zoom-dialog').showModal());
  select('#place-zoom-close').addEventListener('click', () => select('#place-zoom-dialog').close());
  for (const viewer of [select('#place-photo-viewer'), select('#place-zoom-dialog')]) {
    viewer.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      changePlacePhoto(event.key === 'ArrowRight' ? 1 : -1);
    });
    let touch;
    viewer.addEventListener('touchstart', event => { touch = event.touches.length === 1 ? event.touches[0] : undefined; }, { passive: true });
    viewer.addEventListener('touchend', event => {
      if (!touch) return;
      const dx = event.changedTouches[0].clientX - touch.clientX;
      const dy = event.changedTouches[0].clientY - touch.clientY;
      touch = undefined;
      if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy)) changePlacePhoto(dx < 0 ? 1 : -1);
    }, { passive: true });
    viewer.addEventListener('touchcancel', () => { touch = undefined; });
  }
  dialog.addEventListener('close', () => {
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    else select('#day-title').focus({ preventScroll: true });
  });

  for (const day of dates) {
    const dateButton = button(day.label, () => { plan.day = day.id; renderDay(); persist(); });
    dateButton.dataset.planDay = day.id;
    dateButton.append(element('small', '', day.weekday));
    select('#plan-days').append(dateButton);
    dateInput.add(new Option(`${day.label} · ${day.weekday}`, day.id));
  }
  Object.entries(slots).forEach(([id, name]) => slotInput.add(new Option(name, id)));
  for (const [id, name] of [['all', '全城'], ...Object.entries(areas)]) {
    const areaButton = button(name, () => { area = id; renderExplore(); });
    areaButton.dataset.planArea = id;
    select('#map-areas').append(areaButton);
  }
  for (const [id, name] of [['morning', '早上'], ['afternoon', '下午'], ['evening', '晚上'], ['food', '好吃的']]) {
    const rankButton = button(name, () => { rank = id; renderRank(); });
    rankButton.dataset.planRank = id;
    select('#rank-tabs').append(rankButton);
  }
  select('#day-recenter').addEventListener('click', renderDay);
  select('#explore-recenter').addEventListener('click', renderExplore);
  select('#shoot-prev').addEventListener('click', () => changeCameraPhoto(-1));
  select('#shoot-next').addEventListener('click', () => changeCameraPhoto(1));
  select('#shoot-clear').addEventListener('click', () => {
    delete plan.position[plan.day];
    renderDay();
    persist();
    select('#day-title').focus();
  });
  cameraViewer.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    changeCameraPhoto(event.key === 'ArrowLeft' ? -1 : 1);
  });
  let swipeStart;
  const shootImage = select('#shoot-image');
  shootImage.addEventListener('touchstart', event => { swipeStart = event.touches[0]; }, { passive: true });
  shootImage.addEventListener('touchend', event => {
    if (!swipeStart) return;
    const end = event.changedTouches[0];
    const dx = end.clientX - swipeStart.clientX;
    const dy = end.clientY - swipeStart.clientY;
    swipeStart = undefined;
    if (Math.abs(dx) >= 42 && Math.abs(dx) > Math.abs(dy)) changeCameraPhoto(dx < 0 ? 1 : -1);
  }, { passive: true });
  shootImage.addEventListener('touchcancel', () => { swipeStart = undefined; });
  const tabObserver = new MutationObserver(() => { renderDay(); renderExplore(); });
  document.querySelectorAll('.panel').forEach(node => tabObserver.observe(node, { attributes: true, attributeFilter: ['hidden'] }));
  document.addEventListener('guide-filter', event => {
    catalogFilter = event.detail;
    renderCatalog();
  });
  window.CQSync?.register('plan', () => JSON.parse(JSON.stringify(plan)), next => {
    plan = next;
    try { localStorage.setItem(key, JSON.stringify(plan)); } catch {}
    cameraKey = undefined;
    renderDay(); renderCatalog();
    if (currentPlace && currentPlace.kind !== 'hotel') updatePlaceButton();
  });
  renderDay();
  renderExplore();
  renderRank();
  renderCatalog();
})();

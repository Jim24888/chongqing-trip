(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CQSyncCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const copy = x => JSON.parse(JSON.stringify(x));
  const normalize = x => x === undefined ? null : x;
  const stable = x => JSON.stringify(x, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const equal = (a, b) => stable(normalize(a)) === stable(normalize(b));
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const validId = id => typeof id === 'string' && /^[a-z0-9-]{1,80}$/.test(id);
  function validField(field, value) {
    if (typeof field !== 'string' || field.length > 180) return false;
    if (/^day\.(05|06|07)\.[a-z0-9-]{1,80}$/.test(field)) return value === null ||
      (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 &&
       ['morning','afternoon','evening'].includes(value.slot) && typeof value.active === 'boolean');
    if (/^position\.(05|06|07)$/.test(field) || field === 'stay') return value === null || validId(value);
    return (/^pick\.(pick|check)-[a-z0-9-]{1,100}$/.test(field) || /^packing\.[a-z0-9-]{1,120}$/.test(field)) &&
      (value === null || typeof value === 'boolean');
  }
  function validateData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length > 1500) throw new Error('invalid-data');
    for (const [field, value] of Object.entries(data)) if (!validField(field, value)) throw new Error('invalid-field');
    return data;
  }
  function flatten({ plan = {}, picks = {}, packing = {} }) {
    const out = {};
    for (const day of ['05','06','07']) {
      for (const [id, entry] of Object.entries(plan.days?.[day] || {})) {
        if (validId(id)) out[`day.${day}.${id}`] = {slot:entry.slot, active:!!entry.active};
      }
      out[`position.${day}`] = plan.position?.[day] || null;
    }
    out.stay = plan.stay || null;
    for (const [key, value] of Object.entries(picks)) out[`pick.${key}`] = !!value;
    for (const [key, value] of Object.entries(packing)) out[`packing.${key}`] = !!value;
    return validateData(out);
  }
  function inflate(fields, currentPlan = {}) {
    const plan = {...copy(currentPlan), days:{'05':{},'06':{},'07':{}}, position:{}};
    delete plan.stay;
    const picks = {}, packing = {};
    for (const [field,value] of Object.entries(validateData(fields))) {
      const parts = field.split('.');
      if (parts[0] === 'day' && value) plan.days[parts[1]][parts[2]] = copy(value);
      if (parts[0] === 'position' && value) plan.position[parts[1]] = value;
      if (field === 'stay' && value) plan.stay = value;
      if (parts[0] === 'pick' && typeof value === 'boolean') picks[parts[1]] = value;
      if (parts[0] === 'packing' && typeof value === 'boolean') packing[parts[1]] = value;
    }
    return {plan,picks,packing};
  }
  class Engine {
    constructor({snapshot, saved, save = () => {}, changed = () => {}, id = () => crypto.randomUUID()}) {
      this.base = copy(validateData(saved?.base || snapshot.data));
      this.revision = saved?.revision ?? snapshot.revision;
      this.pending = copy(saved?.pending || {});
      this.flight = saved?.flight ? copy(saved.flight) : null;
      this.save = save; this.changed = changed; this.id = id;
      for (const [field, op] of Object.entries(this.pending)) {
        if (!validField(field, op.before) || !validField(field, op.after)) throw new Error('invalid-pending');
      }
      this.receive(snapshot);
    }
    view() {
      const view = copy(this.base);
      for (const [field,op] of Object.entries(this.pending)) view[field] = copy(op.after);
      return view;
    }
    state() { return copy({base:this.base,revision:this.revision,pending:this.pending,flight:this.flight}); }
    notify() { this.save(this.state()); this.changed(this.view(), this.status()); }
    conflicts() {
      return Object.keys(this.pending).filter(field => {
        const op = this.pending[field];
        const flying = this.flight?.changes.find(x => x.field === field);
        return !equal(this.base[field],op.before) && !equal(this.base[field],op.after) &&
          !(flying && equal(this.base[field],flying.after));
      });
    }
    status() { return {pending:Object.keys(this.pending).length,conflicts:this.conflicts(),revision:this.revision,inFlight:!!this.flight}; }
    edit(next) {
      validateData(next);
      const before = this.view();
      for (const field of new Set([...Object.keys(before),...Object.keys(next)])) {
        const after = normalize(next[field]);
        if (equal(before[field],after)) continue;
        const old = this.pending[field];
        this.pending[field] = {before:normalize(old ? old.before : this.base[field]),after:copy(after)};
        if (!this.flight?.changes.some(op => op.field === field) && equal(this.base[field],after)) delete this.pending[field];
      }
      this.notify();
    }
    receive(snapshot) {
      validateData(snapshot.data);
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error('invalid-revision');
      if (snapshot.revision >= this.revision) {
        this.base = copy(snapshot.data); this.revision = snapshot.revision;
        for (const [field,op] of Object.entries(this.pending)) {
          if (!this.flight?.changes.some(x=>x.field===field) && equal(this.base[field],op.after)) delete this.pending[field];
        }
      }
      this.notify();
    }
    request() {
      if (this.flight) return copy(this.flight);
      const conflicts = new Set(this.conflicts());
      const changes = Object.entries(this.pending).filter(([field]) => !conflicts.has(field))
        .slice(0,100).map(([field,op]) => ({field,...copy(op)}));
      if (!changes.length) return null;
      this.flight = {requestId:this.id(),changes}; this.notify(); return copy(this.flight);
    }
    complete(request, response) {
      if (this.flight?.requestId !== request.requestId) throw new Error('wrong-request');
      // Keep the same immutable request across network failures and reloads.
      // Only an acknowledged response can release it.
      if (response.ok) {
        for (const sent of request.changes) {
          const current = this.pending[sent.field];
          if (!current) continue;
          if (equal(current.after,sent.after)) delete this.pending[sent.field];
          else current.before = copy(sent.after);
        }
      }
      this.flight = null;
      this.receive(response);
    }
    resolve(field, choice) {
      if (!has(this.pending,field)) return;
      if (choice === 'server') delete this.pending[field];
      else if (choice === 'mine') this.pending[field].before = normalize(this.base[field]);
      else throw new Error('invalid-choice');
      this.notify();
    }
  }
  return {Engine,flatten,inflate,validateData,validField,equal,copy};
});

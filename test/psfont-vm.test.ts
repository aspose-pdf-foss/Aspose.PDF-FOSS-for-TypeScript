import { describe, expect, it } from 'vitest';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';
import { integer, name, psEquals } from '../src/psvalue.js';
import { psBytes } from './helpers/ps-font-program.js';

describe('protected PostScript font VM objects', () => {
  it('gives FIDs backed identity, fonttype and readonly access', () => {
    const vm = new PsInterpreter(), id = vm.memory.fontId();
    vm.memory.put(vm.userdict, name('fid'), id);
    vm.run(psBytes('fid type fid dup eq fid rcheck fid wcheck fid gcheck'));
    expect(vm.stack).toMatchObject([{ text: 'fonttype' }, { value: true }, { value: true }, { value: false }, { value: false }]);
    expect(psEquals(id, vm.memory.fontId())).toBe(false);
    expect(() => vm.memory.restrictAccess(id, 'unlimited')).toThrow(/invalidaccess/);
  });
  it('invalidates new local FIDs and enforces global retention barriers', () => {
    const vm = new PsInterpreter(), saved = vm.save(), id = vm.memory.fontId();
    vm.push(id);
    expect(() => vm.restore(saved)).toThrow(/invalidrestore/);
    vm.pop(); vm.restore(saved);
    expect(id.body.valid).toBe(false);
    expect(() => vm.memory.put(vm.userdict, name('bad'), id)).toThrow(/invalidrestore/);
    vm.memory.currentGlobal = true;
    const global = vm.memory.dictionary(), gid = vm.memory.fontId();
    vm.memory.currentGlobal = false;
    vm.memory.put(global, name('good'), gid);
    expect(() => vm.memory.put(global, name('bad'), vm.memory.fontId())).toThrow(/invalidaccess/);
  });
  it('lets the exact host registry capability journal writes without exposing source mutation', () => {
    const vm = new PsInterpreter(), registry = vm.memory.readonlyRegistry();
    vm.memory.put(vm.userdict, name('registry'), registry.dictionary);
    registry.put(name('a'), integer(1));
    const saved = vm.save(); registry.put(name('a'), integer(2)); registry.put(name('b'), integer(3));
    vm.restore(saved);
    expect(vm.memory.get(registry.dictionary, name('a'))).toEqual(integer(1));
    expect(vm.memory.lookup(registry.dictionary, name('b'))).toBeUndefined();
    expect(() => vm.run(psBytes('registry /a 9 put'))).toThrow(/invalidaccess/);
    vm.run(psBytes('clear'));
    expect(() => vm.run(psBytes('registry /a undef'))).toThrow(/invalidaccess/);
    registry.remove(name('a'));
    expect(vm.memory.dictionarySize(registry.dictionary)).toBe(0);
  });
  it('reflects parent changes and local shadows in lookup, length, copy and forall', () => {
    const vm = new PsInterpreter(), parent = vm.memory.readonlyRegistry(), local = vm.memory.readonlyRegistry(parent.dictionary);
    vm.memory.put(vm.userdict, name('registry'), local.dictionary);
    parent.put(name('a'), integer(1)); parent.put(name('b'), integer(2)); local.put(name('a'), integer(10));
    vm.run(psBytes('registry length registry 4 dict copy length /sum 0 def registry { exch pop sum add /sum exch def } forall sum'));
    expect(vm.stack).toMatchObject([{ value: 2 }, { value: 2 }, { value: 12 }]);
    parent.remove(name('b')); parent.put(name('c'), integer(3)); local.remove(name('a'));
    vm.run(psBytes('registry /a get registry /b known registry /c get registry length'));
    expect(vm.stack.slice(-4)).toMatchObject([{ value: 1 }, { value: false }, { value: 3 }, { value: 2 }]);
  });
  it('checks overlay parent edges during restore', () => {
    const vm = new PsInterpreter(), saved = vm.save();
    const parent = vm.memory.dictionary(), local = vm.memory.readonlyRegistry(parent);
    // Passing only the child still retains the parent graph.
    expect(() => vm.memory.restore(saved, [local.dictionary])).toThrow(/invalidrestore/);
    vm.memory.currentGlobal = true;
    expect(() => vm.memory.readonlyRegistry(parent)).toThrow(/invalidaccess/);
  });
  it('installs fixed values through every ordinary system dictionary view', () => {
    const vm = new PsInterpreter(); vm.registerStandardValue('probe', integer(7));
    vm.run(psBytes('systemdict /probe get /probe load eq probe'));
    expect(vm.stack).toMatchObject([{ value: true }, { value: 7 }]);
    expect(() => vm.registerStandardValue('local', vm.memory.dictionary())).toThrow(/invalidaccess/);
    expect(vm.lookup('local')).toBeUndefined();
  });
  it('resolves dynamic bindings through get, load, lookup and enumeration with user shadows', () => {
    const vm = new PsInterpreter(), local = vm.memory.dictionary();
    vm.memory.currentGlobal = true; const global = vm.memory.dictionary(); vm.memory.currentGlobal = false;
    vm.registerStandardBinding('directory', () => vm.memory.currentGlobal ? global : local, [local, global]);
    expect(vm.lookup('directory')).toEqual(local);
    vm.run(psBytes('systemdict /directory get /directory load eq true setglobal systemdict /directory get'));
    expect(vm.stack[0]).toMatchObject({ value: true }); expect(vm.stack[1]).toEqual(global);
    const pair = vm.memory.entries(vm.systemdict).find(([key]) => key.kind === 'name' && key.text === 'directory');
    expect(pair?.[1]).toEqual(global);
    vm.run(psBytes('systemdict { exch /directory eq { } { pop } ifelse } forall'));
    expect(vm.stack.at(-1)).toEqual(global);
    vm.run(psBytes('false setglobal /directory 9 def directory systemdict /directory get'));
    expect(vm.stack.at(-2)).toEqual(integer(9)); expect(vm.stack.at(-1)).toEqual(local);
  });
  it('retains declared binding roots during restore without weakening the global barrier', () => {
    const vm = new PsInterpreter(), root = vm.memory.dictionary();
    vm.registerStandardBinding('directory', () => root, [root]);
    const saved = vm.save(); vm.memory.put(root, name('new'), vm.memory.array(1)); vm.restore(saved);
    expect(vm.memory.dictionarySize(root)).toBe(0);
    expect(() => vm.memory.put(vm.globaldict, name('local'), root)).toThrow(/invalidaccess/);
  });
  it('rejects fixed and dynamic installation while executing or with open saves before mutation', () => {
    const vm = new PsInterpreter();
    vm.registerOperator('install', () => vm.registerStandardValue('late', integer(7)));
    expect(() => vm.run(psBytes('install'))).toThrow(/invalidaccess/); expect(vm.lookup('late')).toBeUndefined();
    const saved = vm.save();
    expect(() => vm.registerStandardBinding('late', () => integer(8), [])).toThrow(/invalidaccess/);
    expect(vm.lookup('late')).toBeUndefined(); vm.restore(saved);
  });
  it.each(['initgraphics', 'showpage', 'copypage', 'erasepage', '<< /PageSize [100 200] >> setpagedevice', 'nulldevice'])
    ('preserves selected font across %s', command => {
      const vm = new PsInterpreter(), graphics = installPsGraphics(vm), font = vm.memory.dictionary();
      graphics.state.font = font; vm.run(psBytes(command)); expect(graphics.state.font).toBe(font);
    });
  it('copies selected fonts in gstates and checks their retained roots', () => {
    const vm = new PsInterpreter(), graphics = installPsGraphics(vm), old = vm.memory.dictionary();
    graphics.state.font = old;
    const saved = vm.memory.gstate(graphics.state);
    expect(vm.memory.readGState(saved).font).toBe(old);
    const boundary = vm.save(); graphics.state.font = vm.memory.dictionary();
    vm.push(vm.memory.gstate(graphics.state));
    expect(() => vm.restore(boundary)).toThrow(/invalidrestore/);
    vm.pop(); vm.restore(boundary); expect(graphics.state.font).toBe(old);
    vm.memory.currentGlobal = true;
    expect(() => vm.memory.gstate(graphics.state)).toThrow(/invalidaccess/);
  });
});

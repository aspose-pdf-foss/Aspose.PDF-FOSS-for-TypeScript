import type { PsInterpreter } from './psvm.js';
import type { PsGraphics } from './psgraphics.js';
import type { PsColorState, PsDeviceSpace, PsDevicePaint } from './psstate.js';
import { visitPsColorRoots } from './psstate.js';
import { PsFault, boolean, canRead, integer, name, real,
  type PsArray, type PsString, type PsValue } from './psvalue.js';
import { UnsupportedFeatureError } from './errors.js';

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const deviceSpace = (text: string): text is PsDeviceSpace =>
  text === 'DeviceGray' || text === 'DeviceRGB' || text === 'DeviceCMYK';
const deviceColor = (color: PsColorState): color is Extract<PsColorState, { space: PsDeviceSpace }> =>
  deviceSpace(color.space);

export function psColorComponents(color: PsColorState): number {
  if (color.space === 'Indexed') return 1;
  if (color.space === 'Separation' || color.space === 'DeviceN') return color.names.length;
  if (color.space === 'Pattern') return color.base ? psColorComponents(color.base) : 0;
  return color.space === 'DeviceGray' ? 1 : color.space === 'DeviceRGB' ? 3 : 4;
}

function device(vm: PsInterpreter, space: PsDeviceSpace, descriptor: PsValue = name(space)): PsColorState {
  vm.budget.allocate(128, 'device color');
  return { space, descriptor, components: space === 'DeviceCMYK' ? [0, 0, 0, 1] : space === 'DeviceRGB' ? [0, 0, 0] : [0] };
}

function procedure(vm: PsInterpreter, value: PsValue): PsArray {
  if (value.kind !== 'array' || !value.executable) throw new PsFault('typecheck');
  vm.memory.checkExecutable(value);
  return value;
}

function colorantName(vm: PsInterpreter, value: PsValue): string {
  if (value.kind === 'name') return value.text;
  if (value.kind !== 'string') throw new PsFault('typecheck');
  vm.budget.allocate(64 + value.length * 2, 'colorant name');
  let result = '';
  for (let i = 0; i < value.length; i++) {
    vm.budget.work();
    result += String.fromCharCode((vm.memory.get(value, i) as { value: number }).value);
  }
  return result;
}

export function parsePsColorSpace(vm: PsInterpreter, descriptor: PsValue): PsColorState {
  let value = descriptor;
  const parents: ((child: PsColorState) => PsColorState)[] = [];
  const seen = new Map<object, Set<string>>();
  let result: PsColorState;
  for (;;) {
    vm.budget.work();
    vm.budget.depth(parents.length, 'color space');
    let text: string;
    if (value.kind === 'name') text = value.text;
    else if (value.kind === 'array') {
      const view = `${value.offset}:${value.length}`;
      const views = seen.get(value.body);
      if (views?.has(view)) throw new PsFault('rangecheck');
      vm.budget.allocate(64, 'color space traversal');
      if (views) views.add(view);
      else seen.set(value.body, new Set([view]));
      if (!value.length) throw new PsFault('rangecheck');
      const kind = vm.memory.get(value, 0);
      if (kind.kind !== 'name') throw new PsFault('typecheck');
      text = kind.text;
    } else throw new PsFault('typecheck');
    const source = value;
    if (deviceSpace(text)) {
      if (source.kind === 'array' && source.length !== 1) throw new PsFault('rangecheck');
      result = device(vm, text, source);
      break;
    }
    if (text === 'Pattern') {
      if (source.kind === 'name' || (source.kind === 'array' && source.length === 1)) {
        result = { space: 'Pattern', descriptor: source, components: [] };
        break;
      }
      if (source.kind !== 'array' || source.length !== 2) throw new PsFault('rangecheck');
      vm.budget.allocate(128, 'pattern color space');
      parents.push(child => {
        if (child.space === 'Pattern') throw new PsFault('rangecheck');
        return { space: 'Pattern', descriptor: source, base: child, components: child.components.slice() };
      });
      value = vm.memory.get(source, 1);
      continue;
    }
    if (text !== 'Indexed' && text !== 'Separation' && text !== 'DeviceN') {
      vm.budget.allocate(64 + text.length * 2, 'unsupported color diagnostic');
      vm.budget.work(text.length, 'unsupported color diagnostic');
      throw new UnsupportedFeatureError(`PostScript color space ${text} is unsupported`);
    }
    if (source.kind !== 'array' || source.length !== 4) throw new PsFault('rangecheck');
    vm.budget.allocate(256, 'color space');
    if (text === 'Indexed') {
      const high = vm.memory.get(source, 2), lookup = vm.memory.get(source, 3);
      if (high.kind !== 'integer') throw new PsFault('typecheck');
      if (high.value < 0 || high.value > 4095) throw new PsFault('rangecheck');
      if (lookup.kind === 'string') {
        if (!lookup.body.valid) throw new PsFault('invalidrestore');
        if (!canRead(lookup)) throw new PsFault('invalidaccess');
      } else procedure(vm, lookup);
      parents.push(child => {
        if (child.space === 'Pattern' || child.space === 'Indexed') throw new PsFault('rangecheck');
        if (lookup.kind === 'string' && lookup.length < (high.value + 1) * psColorComponents(child)) throw new PsFault('rangecheck');
        return { space: 'Indexed', descriptor: source, components: [0], base: child,
          high: high.value, lookup: lookup as PsString | PsArray };
      });
      value = vm.memory.get(source, 1);
    } else {
      const colorants = vm.memory.get(source, 1);
      const names: string[] = [];
      if (text === 'Separation') {
        names.push(colorantName(vm, colorants));
      } else {
        if (colorants.kind !== 'array') throw new PsFault('typecheck');
        if (!colorants.length) throw new PsFault('rangecheck');
        vm.budget.allocate(colorants.length * 32, 'DeviceN colorants');
        for (let i = 0; i < colorants.length; i++) {
          const colorant = vm.memory.get(colorants, i);
          const text = colorantName(vm, colorant);
          if (text === 'All' || text === 'None') throw new PsFault('rangecheck');
          names.push(text);
        }
      }
      // The PDF device exposes the four process colorants. Supported native
      // colorants and Separation All/None ignore the alternate parameters.
      const native = names.map(text => ['Cyan', 'Magenta', 'Yellow', 'Black'].indexOf(text));
      if (names.every((text, i) => native[i]! >= 0 || text === 'All' || text === 'None')) {
        result = { space: text, descriptor: source, components: names.map(() => 1), names, native,
          alternate: device(vm, 'DeviceCMYK'), transform: vm.memory.arrayFrom([], true) };
        break;
      }
      const transform = procedure(vm, vm.memory.get(source, 3));
      vm.budget.allocate(names.length * 16, 'initial tint components');
      parents.push(child => {
        if (!deviceSpace(child.space)) throw new PsFault('rangecheck');
        return { space: text, descriptor: source, components: names.map(() => 1), names,
          alternate: child, transform };
      });
      value = vm.memory.get(source, 2);
    }
  }
  while (parents.length) { vm.budget.work(); result = parents.pop()!(result); }
  return result;
}

export function psDevicePaint(color: PsColorState): PsDevicePaint {
  if (deviceSpace(color.space)) return { space: color.space, components: color.components };
  if (!color.prepared) throw new PsFault('undefinedresult');
  return color.prepared;
}

export function preparePsColor(vm: PsInterpreter, space: PsColorState, components: readonly number[],
  complete: (color: PsColorState) => void): void {
  if (components.length !== psColorComponents(space)) throw new PsFault('rangecheck');
  vm.budget.allocate(128 + components.length * 16, 'color components');
  vm.budget.work(components.length, 'color components');
  if (deviceColor(space)) {
    complete({ ...space, components: components.map(clamp), prepared: undefined });
    return;
  }
  if (space.space === 'Pattern') {
    complete({ ...space, components: components.map(clamp) });
    return;
  }
  const selected = components.map(clamp);
  if ((space.space === 'Separation' || space.space === 'DeviceN') && space.native) {
    const values = [0, 0, 0, 0];
    space.names.forEach((text, i) => {
      if (text === 'All') values.fill(selected[i]!);
      else if (space.native![i]! >= 0) values[space.native![i]!] = selected[i]!;
    });
    complete({ ...space, components: selected, prepared: { space: 'DeviceCMYK', components: values,
      none: space.names[0] === 'None' } });
    return;
  }
  const base = space.space === 'Indexed' ? space.base : space.alternate;
  const commit = (color: PsColorState): void => {
    const paint = psDevicePaint(color);
    const none = space.space !== 'Indexed' && space.names.every(text => text === 'None');
    complete({ ...space, components: selected, prepared: { ...paint, none: paint.none || none } });
  };
  if (space.space === 'Indexed') {
    const index = Math.max(0, Math.min(space.high, Math.round(components[0]!)));
    selected[0] = index;
    if (space.lookup.kind === 'string') {
      const count = psColorComponents(base);
      vm.budget.allocate(count * 16, 'indexed color sample');
      const sample: number[] = [];
      for (let i = 0; i < count; i++) {
        const value = vm.memory.get(space.lookup, index * count + i);
        sample.push((value as { value: number }).value / 255);
      }
      preparePsColor(vm, base, sample, commit);
      return;
    }
  }
  const callback = space.space === 'Indexed' ? space.lookup as PsArray : space.transform;
  vm.memory.checkExecutable(callback);
  const before = vm.stack.length;
  if (space.space === 'Indexed') vm.push(integer(selected[0]!));
  else for (const component of selected) vm.push(real(component));
  const roots: PsValue[] = [];
  visitPsColorRoots(space, value => {
    vm.budget.allocate(16, 'color callback root');
    vm.budget.work();
    roots.push(value);
  });
  vm.invoke(callback, {
    roots,
    complete: () => {
      const count = psColorComponents(base);
      if (vm.stack.length !== before + count) throw new PsFault('rangecheck');
      vm.budget.allocate(count * 16, 'color callback result');
      const values: number[] = [];
      for (let i = count - 1; i >= 0; i--) values.push(vm.number(i).value);
      vm.replace(count);
      preparePsColor(vm, base, values, commit);
    },
    unwind: () => {},
  });
}

export function psPaintRgb(paint: PsDevicePaint): number[] {
  const c = paint.components;
  if (paint.space === 'DeviceRGB') return c;
  if (paint.space === 'DeviceGray') return [c[0]!, c[0]!, c[0]!];
  return [1 - Math.min(1, c[0]! + c[3]!), 1 - Math.min(1, c[1]! + c[3]!), 1 - Math.min(1, c[2]! + c[3]!)];
}

function hsb(red: number, green: number, blue: number): number[] {
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), difference = max - min;
  if (difference === 0) return [0, 0, max];
  let hue = max === red ? (green - blue) / difference : max === green ? 2 + (blue - red) / difference : 4 + (red - green) / difference;
  hue = ((hue / 6) + 1) % 1;
  return [hue, max ? difference / max : 0, max];
}

function fromHsb(hue: number, saturation: number, brightness: number): number[] {
  const h = (clamp(hue) * 6) % 6, s = clamp(saturation), b = clamp(brightness);
  const low = b * (1 - s), down = b * (1 - s * (h - Math.floor(h))), up = b * (1 - s * (1 - (h - Math.floor(h))));
  return [[b, up, low], [down, b, low], [low, b, up], [low, down, b], [up, low, b], [b, low, down]][Math.floor(h)]!;
}

export function installPsColor(vm: PsInterpreter, graphics: PsGraphics): void {
  const op = (text: string, execute: () => void): void => vm.registerStandardOperator(text, execute);
  for (const [text, space, count] of [
    ['setgray', 'DeviceGray', 1], ['setrgbcolor', 'DeviceRGB', 3], ['setcmykcolor', 'DeviceCMYK', 4],
  ] as const) op(text, () => {
    graphics.assertColorAllowed();
    const components: number[] = [];
    for (let i = count - 1; i >= 0; i--) components.push(clamp(vm.number(i).value));
    const color = { ...device(vm, space), components };
    vm.replace(count);
    graphics.state.color = color;
  });
  op('sethsbcolor', () => {
    graphics.assertColorAllowed();
    const components = fromHsb(vm.number(2).value, vm.number(1).value, vm.number().value);
    const color = { ...device(vm, 'DeviceRGB'), components };
    vm.replace(3); graphics.state.color = color;
  });
  for (const text of ['currentgray', 'currentrgbcolor', 'currentcmykcolor', 'currenthsbcolor']) op(text, () => {
    const color = graphics.state.color;
    const paint = color.space === 'Pattern' ? { space: 'DeviceRGB' as const, components: [0, 0, 0] } : psDevicePaint(color);
    const c = paint.components;
    const [r, g, b] = psPaintRgb(paint) as [number, number, number];
    let values: number[];
    if (text === 'currentrgbcolor') values = [r, g, b];
    else if (text === 'currenthsbcolor') values = hsb(r, g, b);
    else if (text === 'currentgray') values = paint.space === 'DeviceGray' ? [c[0]!]
      : paint.space === 'DeviceCMYK'
        ? [1 - Math.min(1, 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]! + c[3]!)]
        : [0.3 * r + 0.59 * g + 0.11 * b];
    else if (color.space === 'Pattern') values = [0, 0, 0, 0];
    else if (paint.space === 'DeviceCMYK') values = c;
    else if (paint.space === 'DeviceGray') values = [0, 0, 0, 1 - c[0]!];
    else {
      const cyan = 1 - r, magenta = 1 - g, yellow = 1 - b;
      const black = Math.min(cyan, magenta, yellow);
      values = [cyan - black, magenta - black, yellow - black, black];
    }
    for (const value of values) vm.push(real(clamp(value)));
  });
  op('setcolorspace', () => {
    graphics.assertColorAllowed();
    const space = parsePsColorSpace(vm, vm.peek());
    vm.replace(1);
    preparePsColor(vm, space, space.components, color => { graphics.state.color = color; });
  });
  op('currentcolorspace', () => {
    const descriptor = graphics.state.color.descriptor;
    vm.push(descriptor.kind === 'name' ? vm.memory.arrayFrom([descriptor]) : descriptor);
  });
  op('setcolor', () => {
    graphics.assertColorAllowed();
    const space = graphics.state.color;
    if (space.space === 'Pattern') throw new PsFault('undefinedresult');
    const count = psColorComponents(space), components: number[] = [];
    vm.budget.allocate(count * 16, 'setcolor operands');
    for (let i = count - 1; i >= 0; i--) components.push(vm.number(i).value);
    vm.replace(count);
    preparePsColor(vm, space, components, color => { graphics.state.color = color; });
  });
  op('currentcolor', () => {
    const color = graphics.state.color;
    for (const component of color.components) vm.push(real(component));
    if (color.space === 'Pattern') vm.push(color.pattern ?? { kind: 'null', executable: false });
  });
  for (const [set, get, key] of [
    ['setlinewidth', 'currentlinewidth', 'width'], ['setlinecap', 'currentlinecap', 'cap'],
    ['setlinejoin', 'currentlinejoin', 'join'], ['setmiterlimit', 'currentmiterlimit', 'miter'],
  ] as const) {
    op(set, () => {
      let value = key === 'cap' || key === 'join' ? vm.typed('integer').value : vm.number().value;
      if ((key === 'cap' || key === 'join') && (value < 0 || value > 2)) throw new PsFault('rangecheck');
      if (key === 'miter' && value < 1) throw new PsFault('rangecheck');
      if (key === 'width') value = Math.abs(value);
      vm.replace(1); graphics.state.line[key] = value;
    });
    op(get, () => vm.push(key === 'cap' || key === 'join' ? integer(graphics.state.line[key]) : real(graphics.state.line[key])));
  }
  op('setflat', () => {
    const value = Math.max(0.2, Math.min(100, vm.number().value));
    vm.replace(1); graphics.state.flatness = value;
  });
  op('currentflat', () => vm.push(real(graphics.state.flatness)));
  for (const [set, get, key] of [
    ['setoverprint', 'currentoverprint', 'overprint'], ['setstrokeadjust', 'currentstrokeadjust', 'strokeAdjust'],
  ] as const) {
    op(set, () => { const value = vm.typed('boolean').value; vm.replace(1); graphics.state[key] = value; });
    op(get, () => vm.push(boolean(graphics.state[key])));
  }
  op('setdash', () => {
    const phase = vm.number().value, source = vm.typed('array', 1);
    vm.budget.allocate(source.length * 16, 'dash snapshot');
    const dash: number[] = [];
    let positive = false;
    for (let i = 0; i < source.length; i++) {
      const value = vm.memory.get(source, i);
      if (value.kind !== 'integer' && value.kind !== 'real') throw new PsFault('typecheck');
      if (value.value < 0) throw new PsFault('rangecheck');
      positive ||= value.value > 0;
      dash.push(value.value);
    }
    if (dash.length && !positive) throw new PsFault('rangecheck');
    vm.replace(2);
    graphics.state.line.dash = dash;
    graphics.state.line.dashPhase = phase;
    graphics.state.sourceDash = source;
  });
  op('currentdash', () => {
    vm.push(graphics.state.sourceDash ?? vm.memory.array(0));
    vm.push(real(graphics.state.line.dashPhase));
  });
  for (const text of ['shfill', 'sethalftone', 'setscreen', 'setcolorscreen', 'settransfer',
    'setcolortransfer', 'setblackgeneration', 'setundercolorremoval', 'setcolorrendering',
    'setdevparams', 'setsystemparams', 'setuserparams']) op(text, () => {
    graphics.assertColorAllowed();
    throw new UnsupportedFeatureError(`PostScript ${text} is unsupported`);
  });
}

// 快捷键：按键写法、默认按键不变、改绑时的冲突处理
import { KEY_DEFS, actionFor, assignKey, comboOf, flyActionFor, holdModeOf, keyName, keyOf, keyText, loadKeys, resetKeys, savedKeys, setKey, tokens } from '../src/box/keymap';

type Check = (cond: boolean, msg: string) => void;
type Scenario = (name: string, fn: () => void) => void;

const ev = (key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}, code?: string) => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

export function boxKeymapScenarios(check: Check, scenario: Scenario) {
  scenario('快捷键：按键写法和显示', () => {
    check(comboOf(ev('G', { ctrlKey: true, shiftKey: true })) === 'ctrl+shift+g', 'Ctrl+Shift+G');
    check(comboOf(ev('Control', { ctrlKey: true })) === 'control', '单独按修饰键不带前缀');
    check(comboOf(ev('!', { shiftKey: true }, 'Digit1')) === 'shift+1', 'Shift+数字按数字键算');
    check(keyName(ev(' ')) === 'space', '空格');
    check(tokens('ctrl+shift+g').join() === 'Ctrl,Shift,G', '键帽');
    check(tokens('shift++').join() === 'Shift,+', '加号本身');
    check(tokens('').length === 0, '未设置没有键帽');
  });

  scenario('快捷键：默认按键', () => {
    loadKeys({});
    const pairs: [string, string][] = [['1', 'mode.move'], ['6', 'mode.pattern'], ['g', 'hold.move'], ['control', 'hold.stretch'], ['shift+d', 'dup'], ['ctrl+d', 'dup'], ['x', 'delete'], ['delete', 'delete'], ['backspace', 'delete'], ['shift+tab', 'grid'], ['ctrl+shift+g', 'ungroup'], ['s', 'align']];
    for (const [c, id] of pairs) check(actionFor(c) === id, `${c} → ${id}`);
    check(holdModeOf('r') === 'rotate' && holdModeOf('x') === null, '按住类');
    check(flyActionFor('s') === 'fly.back' && flyActionFor('e') === 'fly.up' && flyActionFor('shift') === 'fly.down', '漫游和编辑分开');
    const edit = KEY_DEFS.filter((d) => !d.fly).map((d) => d.def);
    check(new Set(edit).size === edit.length, '默认按键没有重复');
  });

  scenario('快捷键：改绑、冲突、恢复', () => {
    loadKeys({});
    const taken = assignKey('focus', 's');
    check(taken.length === 1 && taken[0].id === 'align' && keyOf('align') === '', '占用的动作变成未设置');
    check(actionFor('s') === 'focus' && actionFor('f') === null, '新按键生效，旧按键失效');
    check(keyText('align') === '未设置', '显示未设置');
    check(assignKey('fly.forward', 'f').length === 0, '漫游和编辑不算冲突');

    resetKeys();
    assignKey('undo', 'delete');
    check(actionFor('delete') === 'undo' && actionFor('backspace') === 'delete' && keyOf('delete') === 'x', '别名撞了让位，动作本身不受影响');

    resetKeys();
    setKey('guard', 'j');
    setKey('guard', 'h');
    check(!('guard' in savedKeys()), '改回默认就不存');

    loadKeys({ guard: 'j', 没有这个动作: 'k' });
    check(actionFor('j') === 'guard' && !('没有这个动作' in savedKeys()), '载入时丢掉不认识的动作');
    resetKeys();
  });
}

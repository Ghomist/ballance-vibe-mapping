// 快捷键：按键写法、默认按键不变、改绑时的冲突处理
import { KEY_DEFS, MAX_BINDS, actionFor, assignKey, bindsOf, comboOf, flyActionFor, hasKey, holdModeOf, isDefaultKeys, keyName, keyOf, keyText, keyTextAll, loadKeys, removeKey, resetKey, resetKeys, savedKeys, setKey, tokens } from '../src/box/keymap';

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
    const pairs: [string, string][] = [['q', 'mode.select'], ['1', 'mode.move'], ['2', 'mode.rotate'], ['3', 'mode.stretch'], ['4', 'mode.slope'], ['6', 'mode.pattern'], ['7', 'guard'], ['h', 'guard'], ['g', 'hold.move'], ['control', 'hold.stretch'], ['shift+d', 'dup'], ['ctrl+d', 'dup'], ['x', 'delete'], ['delete', 'delete'], ['backspace', 'delete'], ['shift+tab', 'grid'], ['ctrl+shift+g', 'ungroup'], ['s', 'align']];
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
    setKey('guard', '7');
    check(!('guard' in savedKeys()), '改回默认就不存');

    loadKeys({ guard: 'j', 没有这个动作: 'k' });
    check(actionFor('j') === 'guard' && !('没有这个动作' in savedKeys()), '载入时丢掉不认识的动作');
    resetKeys();
  });

  scenario('快捷键：一个动作多个按键', () => {
    loadKeys({});
    check(bindsOf('delete').join() === 'x,delete,backspace' && keyTextAll('delete') === 'X / Delete', '默认的别名也是按键');
    // 改第二个、再加一个、去掉第一个
    assignKey('dup', 'ctrl+b', 1);
    check(bindsOf('dup').join() === 'shift+d,ctrl+b' && actionFor('ctrl+d') === null && actionFor('ctrl+b') === 'dup', '改第二个按键');
    assignKey('dup', 'j', 2);
    check(bindsOf('dup').length === 3 && actionFor('j') === 'dup', '再加一个');
    assignKey('dup', 'l', 3);
    check(bindsOf('dup').length === MAX_BINDS && actionFor('l') === null, `最多 ${MAX_BINDS} 个`);
    removeKey('dup', 0);
    check(keyOf('dup') === 'ctrl+b' && actionFor('shift+d') === null, '去掉主按键，下一个顶上');
    assignKey('dup', 'j', 0);
    check(bindsOf('dup').join() === 'j', '自己已有的键挪到这个位置，不重复');

    // 别的动作的第二个按键被占：只拿掉那一个
    resetKeys();
    const taken = assignKey('undo', 'backspace', 1);
    check(taken.length === 1 && taken[0].id === 'delete' && bindsOf('delete').join() === 'x,delete' && bindsOf('undo').join() === 'ctrl+z,backspace', '从别的动作上移过来');
    // 恢复默认时把默认按键拿回来
    const back = resetKey('delete');
    check(back.length === 1 && back[0].id === 'undo' && isDefaultKeys('undo') && isDefaultKeys('delete') && actionFor('backspace') === 'delete', '恢复默认拿回按键');

    // 按住类：任何一个按键都算
    assignKey('vsnap', 'b', 1);
    check(hasKey('vsnap', 'v') && hasKey('vsnap', 'b') && !hasKey('vsnap', 'n'), '按住类多个键');
    assignKey('hold.move', 'm', 1);
    check(holdModeOf('m') === 'move' && holdModeOf('g') === 'move', '按住切换多个键');

    // 存取：新的是数组；旧版的字符串只换主按键，别名照旧，'' 是只剩别名
    const saved = savedKeys();
    check(Array.isArray(saved.vsnap) && saved.vsnap.join() === 'v,b', '只存改过的，存成数组');
    loadKeys(JSON.parse(JSON.stringify(saved)));
    check(hasKey('vsnap', 'b') && holdModeOf('m') === 'move', '数组读回来');
    loadKeys({ delete: '', dup: 'j', guard: ['j'] });
    check(bindsOf('delete').join() === 'delete,backspace' && bindsOf('dup').join() === 'j,ctrl+d', '旧存档：主按键 + 默认别名');
    check(bindsOf('guard').join() === 'j' && actionFor('h') === null, '数组就是全部按键');
    loadKeys({ align: [] });
    check(keyOf('align') === '' && actionFor('s') === null && keyText('align') === '未设置', '空数组是未设置');
    resetKeys();
  });
}

# 在 Blender（已安装 BBP 插件）里运行：把编辑器导出的场景描述生成 Ballance 地图。
#
#   blender -b --python scripts/blender/build_scene.py -- <场景.json> [--blend 输出.blend] [--nmo 输出.nmo]
#           [--assets BallanceAssets.blend] [--textures Ballance/Textures]
#
# 也可以在 Blender 的脚本编辑器里打开本文件，修改下面的 DEFAULTS 后直接运行（结果留在当前场景里）。
import bpy, bmesh, json, math, os, sys, importlib, addon_utils, mathutils

DEFAULTS = {
    'scene': '',
    'blend': '',
    'nmo': '',
    'assets': r'D:/BlenderLibrary/BallanceAssets/BallanceAssets.blend',
    'textures': r'D:/Ballance/Textures',
}


def parse_args():
    opts = dict(DEFAULTS)
    if '--' not in sys.argv:
        return opts
    args = sys.argv[sys.argv.index('--') + 1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith('--'):
            opts[a[2:]] = args[i + 1]
            i += 2
        else:
            opts['scene'] = a
            i += 1
    return opts


def load_bbp():
    """找到并启用 BBP（新版扩展或旧版插件都行），返回其包模块"""
    for name in list(sys.modules):
        if name.endswith('bbp_ng') and hasattr(sys.modules[name], 'OP_EXPORT_virtools'):
            return sys.modules[name]
    for mod in addon_utils.modules():
        if mod.__name__.endswith('bbp_ng'):
            addon_utils.enable(mod.__name__, default_set=True)
            return importlib.import_module(mod.__name__)
    raise RuntimeError('没有找到 BBP 插件（bbp_ng），请先在 Blender 里安装')


def main():
    opts = parse_args()
    if not opts['scene']:
        raise RuntimeError('需要场景描述文件（编辑器“导出”得到的 .json）')
    desc = json.load(open(opts['scene'], encoding='utf8'))
    assert desc.get('format') == 'bvm-scene', '不是 BVM 导出的场景描述'
    for w in desc.get('warnings', []):
        print('警告：', w)

    bbp = load_bbp()
    sub = lambda n: importlib.import_module(f'{bbp.__name__}.{n}')
    PROP_preferences = sub('PROP_preferences')
    PROP_bme_material = sub('PROP_bme_material')
    PROP_ballance_element = sub('PROP_ballance_element')
    PROP_ballance_map_info = sub('PROP_ballance_map_info')
    PROP_virtools_group = sub('PROP_virtools_group')
    UTIL_naming_convention = sub('UTIL_naming_convention')
    UTIL_virtools_types = sub('UTIL_virtools_types')
    OP_UV_rail_uv = sub('OP_UV_rail_uv')
    OP_EXPORT_virtools = sub('OP_EXPORT_virtools')
    Info = UTIL_naming_convention.BallanceObjectInfo
    ObjType = UTIL_naming_convention.BallanceObjectType

    # BBP 需要知道 Ballance 贴图目录（BME 材质、导出时都要用）
    prefs = PROP_preferences.get_preferences()
    if not os.path.isdir(prefs.ballance_texture_folder):
        prefs.ballance_texture_folder = opts['textures']
    if not os.path.isdir(prefs.ballance_texture_folder):
        raise RuntimeError(f'找不到 Ballance 贴图目录：{prefs.ballance_texture_folder}')

    scene = bpy.context.scene
    if bpy.app.background:
        # 命令行模式：清掉默认场景里的立方体、相机、灯光
        for o in list(bpy.data.objects):
            bpy.data.objects.remove(o)
    coll = bpy.data.collections.new('BVM')
    scene.collection.children.link(coll)
    created = []

    def set_info(obj, info):
        UTIL_naming_convention.YYCToolchainConvention.set_to_object(obj, info, None)
        UTIL_naming_convention.VirtoolsGroupConvention.set_to_object(obj, info, None)

    def place(obj, pos, rot_z, pitch=0.0):
        obj.matrix_world = (mathutils.Matrix.Translation(pos)
                            @ mathutils.Matrix.Rotation(math.radians(rot_z), 4, 'Z')
                            @ mathutils.Matrix.Rotation(math.radians(pitch or 0.0), 4, 'Y'))

    # 挡块材质：原版的木头贴图
    _stopper = []
    def stopper_material():
        if _stopper: return _stopper[0]
        PROP_virtools_material = sub('PROP_virtools_material')
        PROP_virtools_texture = sub('PROP_virtools_texture')
        UTIL_ballance_texture = sub('UTIL_ballance_texture')
        mtl = bpy.data.materials.new('Floor_Stopper_Wood')
        raw = PROP_virtools_material.RawVirtoolsMaterial()
        tex = UTIL_ballance_texture.load_ballance_texture('E_Holzbeschlag.bmp')
        PROP_virtools_texture.set_raw_virtools_texture(tex, PROP_virtools_texture.get_ballance_texture_preset('E_Holzbeschlag.bmp'))
        raw.mTexture = tex
        PROP_virtools_material.set_raw_virtools_material(mtl, raw)
        PROP_virtools_material.apply_to_blender_material(mtl)
        _stopper.append(mtl)
        return mtl

    # ---------- 路面与钢轨 ----------
    rail_meshes = []
    with PROP_bme_material.BMEMaterialsHelper(scene) as mtls:
        for m in desc['meshes']:
            mesh = bpy.data.meshes.new(m['name'])
            bm = bmesh.new()
            uv_layer = bm.loops.layers.uv.new()
            for mi, part in enumerate(m['parts']):
                mesh.materials.append(stopper_material() if part['mat'] == 'Stopper' else mtls.get_material(part['mat']))
                pos, uv = part['pos'], part.get('uv')
                for t in range(0, len(pos), 9):
                    vs = [bm.verts.new(pos[t + k * 3:t + k * 3 + 3]) for k in range(3)]
                    try:
                        f = bm.faces.new(vs)
                    except ValueError:
                        continue
                    f.material_index = mi
                    f.smooth = bool(m.get('smooth'))
                    if uv:
                        b = t // 3 * 2
                        for k, loop in enumerate(f.loops):
                            loop[uv_layer].uv = (uv[b + k * 2], uv[b + k * 2 + 1])
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
            bm.to_mesh(mesh)
            bm.free()
            obj = bpy.data.objects.new(m['name'], mesh)
            coll.objects.link(obj)
            set_info(obj, Info.create_from_others({'floor': ObjType.FLOOR, 'rail': ObjType.RAIL, 'stopper': ObjType.STOPPER}[m['kind']]))
            obj.name = m['name']
            if m['kind'] == 'rail':
                rail_meshes.append(mesh)
            created.append(obj)
        # 钢轨用 BBP 的反射贴图 UV
        if rail_meshes:
            OP_UV_rail_uv._create_rail_uv(rail_meshes, mtls.get_material('Rail'))

    # ---------- 资产库物体 ----------
    names = sorted({a['asset'] for a in desc['assets']})
    src = {}
    if names:
        with bpy.data.libraries.load(opts['assets'], link=False) as (data_from, data_to):
            data_to.objects = [n for n in names if n in data_from.objects]
        for o in data_to.objects:
            if o is not None:
                src[o.name] = o
    prefix = {'floor': 'A_Floor_', 'rail': 'A_Rail_', 'deco': 'D_'}
    for a in desc['assets']:
        s = src.get(a['asset'])
        if s is None:
            print('资产库里没有', a['asset'])
            continue
        obj = bpy.data.objects.new(prefix[a['kind']] + a['asset'], s.data)  # 共用网格数据
        coll.objects.link(obj)
        with PROP_virtools_group.VirtoolsGroupsHelper(s) as gs:
            groups = list(gs.iterate_groups())
        with PROP_virtools_group.VirtoolsGroupsHelper(obj) as gd:
            gd.add_groups(groups)
        place(obj, a['pos'], a['rotZ'], a.get('pitch'))
        created.append(obj)
    # 追加进来的原物体只用来提供网格，不放进场景
    for o in src.values():
        bpy.data.objects.remove(o)

    # ---------- 机关占位符 ----------
    with PROP_ballance_element.BallanceElementsHelper(scene) as elements:
        for e in desc['elements']:
            ty = PROP_ballance_element.get_ballance_element_type_from_name(e['type'])
            if ty is None:
                print('未知机关', e['type'])
                continue
            obj = bpy.data.objects.new('', elements.get_element(ty))
            coll.objects.link(obj)
            T = PROP_ballance_element.BallanceElementType
            if ty == T.PS_FourFlames:
                info = Info.create_from_others(ObjType.LEVEL_START)
            elif ty == T.PE_Balloon:
                info = Info.create_from_others(ObjType.LEVEL_END)
            elif ty == T.PC_TwoFlames:
                info = Info.create_from_checkpoint(e['sector'])
            elif ty == T.PR_Resetpoint:
                info = Info.create_from_resetpoint(e['sector'])
            else:
                info = Info.create_from_component(e['type'], e['sector'])
            set_info(obj, info)
            place(obj, e['pos'], e['rotZ'])
            created.append(obj)

    # 小节数：导出时会补齐 Sector_01..N 组
    info = PROP_ballance_map_info.get_raw_ballance_map_info(scene)
    info.mSectorCount = max(1, int(desc['sectors']))
    PROP_ballance_map_info.set_raw_ballance_map_info(scene, info)
    print(f'已生成 {len(created)} 个物体，{desc["sectors"]} 个小节')

    if opts['blend']:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(opts['blend']))
        print('已保存', opts['blend'])
    if opts['nmo']:
        OP_EXPORT_virtools._export_virtools(
            os.path.abspath(opts['nmo']),
            tuple(UTIL_virtools_types.g_PybmapDefaultEncodings),
            UTIL_virtools_types.CK_TEXTURE_SAVEOPTIONS.CKTEXTURE_EXTERNAL,
            True, 5,
            True, info.mSectorCount,
            tuple(coll.all_objects),
        )
        print('已导出', opts['nmo'])


main()

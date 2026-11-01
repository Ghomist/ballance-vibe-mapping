# 在 Blender（已安装 BBP 插件）里运行：用 BMap 读一个 .nmo，把里面的物体、网格、材质、贴图、组导出成 JSON。
#
#   blender -b --python scripts/blender/dump_nmo.py -- <输入.nmo> <输出.json> [--textures Ballance/Textures]
#
# 用途：生成网页端 NMO 导出用的素材库（scripts/build-nmo-lib.ts），以及对比两个 .nmo 的内容（scripts/nmo-check.ts）。
import bpy, json, os, sys, tempfile, importlib, addon_utils


def load_bbp():
    for mod in addon_utils.modules():
        if mod.__name__.endswith('bbp_ng'):
            addon_utils.enable(mod.__name__, default_set=True)
            return importlib.import_module(mod.__name__)
    raise RuntimeError('没有找到 BBP 插件（bbp_ng）')


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    src, out = args[0], args[1]
    textures = args[args.index('--textures') + 1] if '--textures' in args else 'D:/Ballance/Textures'
    bbp = load_bbp()
    bmap = importlib.import_module(f'{bbp.__name__}.pybmap.bmap_wrapper')
    vt = importlib.import_module(f'{bbp.__name__}.UTIL_virtools_types')

    col = lambda c: [c.r, c.g, c.b, c.a]
    ev = lambda e: int(e)
    res = {'textures': [], 'materials': [], 'meshes': [], 'objects': [], 'groups': []}
    with tempfile.TemporaryDirectory() as tmp:
        with bmap.BMFileReader(os.path.abspath(src), tmp, textures, tuple(vt.g_PybmapDefaultEncodings)) as r:
            for t in r.get_textures():
                fn = t.get_file_name()
                size = None
                if fn:
                    p = os.path.join(textures, os.path.basename(fn))
                    if os.path.isfile(p):
                        img = bpy.data.images.load(p)
                        size = list(img.size)
                        bpy.data.images.remove(img)
                res['textures'].append({
                    'name': t.get_name(), 'file': os.path.basename(fn) if fn else None, 'size': size,
                    'saveOptions': ev(t.get_save_options()), 'videoFormat': ev(t.get_video_format()),
                })
            for m in r.get_materials():
                tex = m.get_texture()
                res['materials'].append({
                    'name': m.get_name(),
                    'diffuse': col(m.get_diffuse()), 'ambient': col(m.get_ambient()),
                    'specular': col(m.get_specular()), 'emissive': col(m.get_emissive()),
                    'specularPower': m.get_specular_power(),
                    'texture': tex.get_name() if tex else None,
                    'textureBorderColor': col(m.get_texture_border_color()),
                    'textureBlendMode': ev(m.get_texture_blend_mode()),
                    'textureMinMode': ev(m.get_texture_min_mode()), 'textureMagMode': ev(m.get_texture_mag_mode()),
                    'textureAddressMode': ev(m.get_texture_address_mode()),
                    'sourceBlend': ev(m.get_source_blend()), 'destBlend': ev(m.get_dest_blend()),
                    'fillMode': ev(m.get_fill_mode()), 'shadeMode': ev(m.get_shade_mode()),
                    'alphaTest': m.get_alpha_test_enabled(), 'alphaBlend': m.get_alpha_blend_enabled(),
                    'perspectiveCorrection': m.get_perspective_correction_enabled(),
                    'zWrite': m.get_z_write_enabled(), 'twoSided': m.get_two_sided_enabled(),
                    'alphaRef': m.get_alpha_ref(), 'alphaFunc': ev(m.get_alpha_func()), 'zFunc': ev(m.get_z_func()),
                })
            for m in r.get_meshs():
                res['meshes'].append({
                    'name': m.get_name(), 'litMode': ev(m.get_lit_mode()),
                    'pos': [c for v in m.get_vertex_positions() for c in (v.x, v.y, v.z)],
                    'nml': [c for v in m.get_vertex_normals() for c in (v.x, v.y, v.z)],
                    'uv': [c for v in m.get_vertex_uvs() for c in (v.x, v.y)],
                    'faces': [i for f in m.get_face_indices() for i in (f.i1, f.i2, f.i3)],
                    'faceMtl': list(m.get_face_material_slot_indexs()),
                    'mtls': [s.get_name() if s else None for s in m.get_material_slots()],
                })
            for o in r.get_3dobjects():
                mesh = o.get_current_mesh()
                res['objects'].append({
                    'name': o.get_name(), 'mesh': mesh.get_name() if mesh else None,
                    'matrix': [c for row in o.get_world_matrix().data for c in row],
                    'visible': o.get_visibility(),
                })
            for g in r.get_groups():
                res['groups'].append({'name': g.get_name(), 'objects': [o.get_name() for o in g.get_objects()]})
    with open(out, 'w', encoding='utf8') as f:
        json.dump(res, f, ensure_ascii=False)
    print('已导出', out)


main()

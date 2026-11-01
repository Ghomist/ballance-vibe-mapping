# 在 Blender 里运行：把资产库中编辑器要用到的物体导出成 JSON（按材质分组的三角形，坐标为 Blender 世界坐标）
#   blender -b BallanceAssets.blend --python scripts/dump-blend-assets.py -- <输出目录> <物体名...>
import bpy, bmesh, json, os, sys

args = sys.argv[sys.argv.index('--') + 1:]
out_dir, names = args[0], args[1:]
os.makedirs(out_dir, exist_ok=True)

def mat_info(m):
    tex = None
    if m and m.use_nodes:
        for n in m.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image:
                tex = os.path.basename(n.image.filepath or n.image.name)
                break
    vt = getattr(m, 'virtools_material', None) if m else None
    info = {'name': m.name if m else None, 'texture': tex}
    if m:
        info['color'] = list(m.diffuse_color)[:3]
    if vt is not None:
        try:
            info['diffuse'] = list(vt.diffuse)[:4]
            info['alphaTest'] = bool(vt.enable_alpha_test)
            info['alphaBlend'] = bool(vt.enable_alpha_blend)
        except Exception:
            pass
    return info

for name in names:
    # 物体名，或集合名（集合里所有网格物体合成一个文件，例如假机关 Fake_Modul_08）
    o = bpy.data.objects.get(name)
    coll = None if o else bpy.data.collections.get(name)
    objs = [o] if o and o.type == 'MESH' else [x for x in coll.all_objects if x.type == 'MESH'] if coll else []
    if not objs:
        print('missing', name); continue
    parts = {}
    for ob in objs:
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bm.transform(ob.matrix_world)
        bmesh.ops.triangulate(bm, faces=bm.faces)
        uv = bm.loops.layers.uv.active
        mats = ob.data.materials
        for f in bm.faces:
            m = mats[f.material_index] if f.material_index < len(mats) else None
            key = m.name if m else None
            if key not in parts:
                parts[key] = dict(mat_info(m), pos=[], uv=[], nrm=[])
            p = parts[key]
            for l in f.loops:
                p['pos'] += [round(c, 5) for c in l.vert.co]
                p['uv'] += [round(c, 5) for c in (l[uv].uv if uv else (0, 0))]
                p['nrm'] += [round(c, 4) for c in (f.normal if not f.smooth else l.vert.normal)]
        bm.free()
    res = {'name': name, 'parts': list(parts.values())}
    groups = []
    try:
        groups = [g.group_name for g in objs[0].virtools_groups]
    except Exception:
        pass
    res['groups'] = groups
    json.dump(res, open(os.path.join(out_dir, name + '.json'), 'w'), separators=(',', ':'))
    print('ok', name, sum(len(p['pos']) // 9 for p in parts.values()), 'tris', groups)

import sys, subprocess, json
from pathlib import Path
root = Path('C:/Users/Administrator/Downloads/img2threejs-main')
sys.path.insert(0, str(root / 'forge/stage1_intake'))
from build_detail_inventory import load_image, write_png_rgb
w, h, pixels = load_image(Path('public/reference/render.png'))
regions = {'white': (.475,.325,.05,.025), 'blue': (.425,.385,.025,.018), 'silver': (.334,.67,.021,.018), 'graphite': (.384,.662,.031,.018), 'black': (.57,.513,.023,.017), 'rubber': (.463,.85,.023,.012)}
reports = {}
for name, (x,y,dx,dy) in regions.items():
    x0,y0,x1,y1 = round(x*w),round(y*h),round((x+dx)*w),round((y+dy)*h)
    crop = [pixels[j*w+i][:3] for j in range(y0,y1) for i in range(x0,x1)]
    dest = Path('evidence') / ('material-'+name+'.png')
    write_png_rgb(dest, x1-x0, y1-y0, crop)
    out = Path('evidence/materials') / name
    proc = subprocess.run([sys.executable,str(root/'forge/stage1_intake/extract_pbr_evidence.py'),str(dest),'--out-dir',str(out),'--material-id',name,'--size','128','--target-threshold','0.7','--report',str(out/'report.json')],capture_output=True,text=True)
    report = json.loads((out/'report.json').read_text())
    reports[name] = {'confidence':report['confidence'], 'ok':report['ok'], 'crop':str(dest), 'region':[x,y,dx,dy], 'report':str(out/'report.json')}
    print(name, report['confidence'], report['ok'])
Path('evidence/material-evidence.json').write_text(json.dumps(reports,indent=2))

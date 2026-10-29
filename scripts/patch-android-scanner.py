"""Install the scanner file bridge after the UI patch has created MainActivity."""
from pathlib import Path
import argparse
import shutil
import xml.etree.ElementTree as ET

def patch(android_dir):
    source_root = Path(__file__).resolve().parent.parent
    package = Path(android_dir) / 'app/src/main/java/com/plotedge/app'
    main = package / 'MainActivity.java'
    if not main.exists():
        raise RuntimeError('Run cap add android and patch-android-ui.py first')
    text = main.read_text()
    registration = 'registerPlugin(PlotScanPlugin.class);'
    if registration not in text:
        anchor = 'super.onCreate(savedInstanceState);'
        if anchor not in text:
            raise RuntimeError('MainActivity onCreate was not found')
        text = text.replace(anchor, registration + '\n        ' + anchor, 1)
        main.write_text(text)
    shutil.copyfile(source_root / 'native/android/PlotScanPlugin.java', package / 'PlotScanPlugin.java')
    manifest = Path(android_dir) / 'app/src/main/AndroidManifest.xml'
    ns = 'http://schemas.android.com/apk/res/android'
    ET.register_namespace('android', ns)
    tree = ET.parse(manifest)
    root = tree.getroot()
    feature = next((item for item in root.findall('uses-feature') if item.get('{' + ns + '}name') == 'android.hardware.usb.host'), None)
    if feature is None:
        feature = ET.SubElement(root, 'uses-feature', {'{' + ns + '}name': 'android.hardware.usb.host'})
    feature.set('{' + ns + '}required', 'false')
    tree.write(manifest, encoding='utf-8', xml_declaration=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--android-dir', default=str(Path(__file__).resolve().parent.parent / 'android'))
    patch(parser.parse_args().android_dir)

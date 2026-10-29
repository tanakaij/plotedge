package com.plotedge.app;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.net.Uri;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;

/**
 * File import and USB inventory for 3D scans. This is NOT a scanner driver:
 * liveCapture stays false until a vendor adapter is tested on real hardware.
 * See SCANNER-INTEGRATION.md.
 */
@CapacitorPlugin(name = "PlotScan")
public class PlotScanPlugin extends Plugin {
    private static final long MAX_IMPORT_BYTES = 64L * 1024L * 1024L;
    private static final String IMPORT_DIR = "scanner-imports";

    private File importDirectory() {
        File directory = new File(getContext().getCacheDir(), IMPORT_DIR);
        if (!directory.exists()) directory.mkdirs();
        return directory;
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supportsFileImport", true);
        result.put("liveCapture", false);
        JSArray devices = new JSArray();
        try {
            UsbManager manager = (UsbManager) getContext().getSystemService(android.content.Context.USB_SERVICE);
            if (manager != null) {
                HashMap<String, UsbDevice> list = manager.getDeviceList();
                if (list != null) {
                    for (UsbDevice device : list.values()) {
                        JSObject item = new JSObject();
                        // Product name needs USB permission on newer Android; fall back to the device node.
                        String name = null;
                        try { name = device.getProductName(); } catch (SecurityException ignored) { }
                        item.put("name", name != null ? name : device.getDeviceName());
                        item.put("vendorId", device.getVendorId());
                        item.put("productId", device.getProductId());
                        devices.put(item);
                    }
                }
            }
        } catch (Exception ignored) {
            // Inventory is best effort; file import does not depend on it.
        }
        result.put("usbDevices", devices);
        call.resolve(result);
    }

    @PluginMethod
    public void pickScan(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
            "model/gltf-binary", "model/gltf+json", "application/octet-stream", "application/x-ply", "text/plain"
        });
        startActivityForResult(call, intent, "pickScanResult");
    }

    @ActivityCallback
    private void pickScanResult(PluginCall call, ActivityResult activityResult) {
        if (call == null) return;
        if (activityResult == null || activityResult.getResultCode() != Activity.RESULT_OK
                || activityResult.getData() == null || activityResult.getData().getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        Uri uri = activityResult.getData().getData();
        String name = displayName(uri);
        File target = null;
        try {
            File directory = importDirectory();
            cleanOld(directory);
            target = new File(directory, System.currentTimeMillis() + "-" + safeName(name));
            long bytes = copyBounded(uri, target);
            JSObject result = new JSObject();
            result.put("name", name);
            result.put("path", target.getAbsolutePath());
            result.put("bytes", bytes);
            result.put("source", "android-files");
            call.resolve(result);
        } catch (Exception e) {
            if (target != null) target.delete();
            call.reject(e.getMessage() != null ? e.getMessage() : "The scan file could not be imported.");
        }
    }

    @PluginMethod
    public void releaseImport(PluginCall call) {
        String path = call.getString("path");
        JSObject result = new JSObject();
        boolean deleted = false;
        if (path != null) {
            File directory = importDirectory();
            File file = new File(path);
            // Only ever delete a file sitting directly inside the import cache.
            if (directory.equals(file.getParentFile()) && file.isFile()) deleted = file.delete();
        }
        result.put("deleted", deleted);
        call.resolve(result);
    }

    private long copyBounded(Uri uri, File target) throws IOException {
        long total = 0;
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("The selected file could not be opened.");
            try (OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) != -1) {
                    total += n;
                    if (total > MAX_IMPORT_BYTES) throw new IOException("The scan is larger than the 64 MiB import limit.");
                    out.write(buffer, 0, n);
                }
            }
        }
        return total;
    }

    private String displayName(Uri uri) {
        String name = null;
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) name = cursor.getString(index);
            }
        } catch (Exception ignored) { }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment();
        return name != null && !name.isEmpty() ? name : "scan";
    }

    private String safeName(String name) {
        String clean = name.replaceAll("[^A-Za-z0-9._-]", "_");
        return clean.length() > 80 ? clean.substring(clean.length() - 80) : clean;
    }

    /** Remove stale temporary imports so the cache cannot grow without bound. */
    private void cleanOld(File directory) {
        File[] files = directory.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - 60L * 60L * 1000L;
        for (File file : files) {
            if (file.isFile() && file.lastModified() < cutoff) file.delete();
        }
    }
}

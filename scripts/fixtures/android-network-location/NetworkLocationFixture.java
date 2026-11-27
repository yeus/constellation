package space.taskyon.constellation.locationfixture;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.location.Criteria;
import android.location.Location;
import android.location.LocationManager;
import android.os.SystemClock;

/**
 * Emulator-only fixture (API 29 and API 36). ADB grants this APK the mock-location app op;
 * Constellation never receives that permission or ships this code.
 */
public final class NetworkLocationFixture extends BroadcastReceiver {
    private static final String PROVIDER = LocationManager.NETWORK_PROVIDER;

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
            String operation = intent.getStringExtra("operation");
            if ("prepare".equals(operation)) {
                manager.addTestProvider(PROVIDER, true, false, false, false, false, false, false,
                    Criteria.POWER_LOW, Criteria.ACCURACY_COARSE);
                manager.setTestProviderEnabled(PROVIDER, true);
            } else if ("fix".equals(operation)) {
                double latitude = Double.parseDouble(intent.getStringExtra("latitude"));
                double longitude = Double.parseDouble(intent.getStringExtra("longitude"));
                if (!Double.isFinite(latitude) || !Double.isFinite(longitude)
                    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
                    throw new IllegalArgumentException("Invalid coordinates");
                }
                Location location = new Location(PROVIDER);
                location.setLatitude(latitude);
                location.setLongitude(longitude);
                location.setAccuracy(20f);
                location.setTime(System.currentTimeMillis());
                location.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());
                manager.setTestProviderLocation(PROVIDER, location);
            } else if ("reset".equals(operation)) {
                manager.removeTestProvider(PROVIDER);
            } else {
                throw new IllegalArgumentException("Unknown fixture operation");
            }
            setResultCode(0);
        } catch (RuntimeException error) {
            // Do not expose precise locations or arbitrary exception messages.
            setResultCode(1);
            setResultData(error.getClass().getSimpleName());
        }
    }
}

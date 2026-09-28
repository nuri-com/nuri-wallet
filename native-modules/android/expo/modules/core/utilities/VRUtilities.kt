package expo.modules.core.utilities

import android.os.Build

class VRUtilities {
  companion object {
    const val HZOS_CAMERA_PERMISSION = "com.oculus.permission.CAMERA"

    @JvmStatic
    fun isQuest(): Boolean {
      val manufacturer = Build.MANUFACTURER.lowercase()
      return manufacturer.contains("oculus") || manufacturer.contains("meta")
    }
  }
}

; Uninstall hooks for the NSIS installer (Windows).
;
; The inbox of dropped files and the log live in %LOCALAPPDATA%\Nooky and are
; ours. Preferences (%APPDATA%\Nooky) are kept, and the sync folder in Google
; Drive is never touched: it holds the task list shared with the other devices.

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\Nooky\inbox"
  Delete "$LOCALAPPDATA\Nooky\nooky.log"
!macroend

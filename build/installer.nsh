; Windows installer additions (electron-builder adds this file by itself).
; The app was called "Multistream 3". When an update installs "Multistream", remove the old shortcuts,
; so searching the Start menu only finds "Multistream".
!macro customInstall
  Delete "$SMPROGRAMS\Multistream 3.lnk"
  Delete "$DESKTOP\Multistream 3.lnk"
!macroend

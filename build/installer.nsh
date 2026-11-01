; 앱 제거 시 사용자 데이터(스캔 캐시, 설정, 정리 기록, 로그) 삭제 여부를 묻는다. 기본 선택은 "아니요".
; 조용한 제거(/S)나 업데이트 중에는 묻지 않고 보존한다.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "사용자 데이터(스캔 결과 캐시, 설정, 정리 기록, 로그)도 함께 삭제할까요?$\n$\n위치: $APPDATA\disklens$\n$\n'아니요'를 고르면 데이터를 남겨 두어 나중에 다시 설치해도 이어서 쓸 수 있습니다." /SD IDNO IDNO diskLensKeepData
      RMDir /r "$APPDATA\disklens"
    diskLensKeepData:
  ${endIf}
!macroend

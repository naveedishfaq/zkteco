Set WshShell = CreateObject("WScript.Shell")
cmd = "powershell -NoProfile -WindowStyle Hidden -Command " & _
      """Get-CimInstance Win32_Process -Filter \""Name='node.exe'\"" | " & _
      "Where-Object { $_.CommandLine -like '*app\server.js*' } | " & _
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"""
WshShell.Run cmd, 0, True

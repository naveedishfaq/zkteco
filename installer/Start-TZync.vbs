Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = appDir & "\runtime\node\node.exe"
serverJs = appDir & "\app\server.js"

WshShell.CurrentDirectory = appDir & "\app"
WshShell.Run """" & nodeExe & """ """ & serverJs & """", 0, False

WScript.Sleep 2500
WshShell.Run "http://localhost:3000"

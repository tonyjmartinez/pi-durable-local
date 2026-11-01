# Forward all arguments to pd-chat inside WSL. Arguments are passed as an array (no shell string), so
# quotes, $, & and newlines in message text reach pd-chat intact.
$distro = if ($env:PD_WSL_DISTRO) { $env:PD_WSL_DISTRO } else { "Ubuntu" }
& wsl.exe -d $distro -e /home/tonyjmartinez/proj/pi-durable-local/bin/pd-chat @args
exit $LASTEXITCODE

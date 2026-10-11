@echo off
rem capinfos stub for Windows: emulates capinfos --version and metadata output.

if "%1"=="--version" (
    echo Capinfos (Wireshark) 4.6.6-windows-stub
    exit /b 0
)

if "%2"=="fail.pcap" (
    echo capinfos: The file is not a capture file 1>&2
    exit /b 1
)

echo File name:           capture.pcap
echo File type:           Wireshark/tcpdump/... - pcap
echo File encapsulation:  Ethernet
echo Packet size limit:   file hdr: 262144 bytes
echo Number of packets:   3
echo Capture duration:    0.123 seconds
echo SHA256:              irrelevant
exit /b 0

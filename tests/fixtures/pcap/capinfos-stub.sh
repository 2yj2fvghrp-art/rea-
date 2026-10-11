#!/bin/sh
# POSIX capinfos stub (mirrors capinfos-stub.cmd for Windows parity).
if [ "$1" = "--version" ]; then printf 'Capinfos (Wireshark) 4.6.6-posix-stub\n'; exit 0; fi
case "$2" in *fail*) printf 'capinfos: The file is not a capture file\n' >&2; exit 1;; esac
printf '%s\n' 'File name:           capture.pcap'
printf '%s\n' 'File type:           Wireshark/tcpdump/... - pcap'
printf '%s\n' 'File encapsulation:  Ethernet'
printf '%s\n' 'Packet size limit:   file hdr: 262144 bytes'
printf '%s\n' 'Number of packets:   3'
printf '%s\n' 'Capture duration:    0.123 seconds'
printf '%s\n' 'SHA256:              irrelevant'
exit 0

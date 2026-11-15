"""Tag an MP4 as a 360 equirectangular video (Google Spherical Video V1 'uuid' box in the video track).

Same box Google's spatial-media injector writes, so YouTube and phone 360 players treat it as 360.
Needs the moov box after mdat (ffmpeg's default without +faststart), so no chunk offsets move.
"""
import struct
import sys

UUID = bytes.fromhex("ffcc8263f8554a938814587a02521fdd")
XML = (b'<?xml version="1.0"?><rdf:SphericalVideo\n'
       b'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"\n'
       b'xmlns:GSpherical="http://ns.google.com/videos/1.0/spherical/">'
       b'<GSpherical:Spherical>true</GSpherical:Spherical>'
       b'<GSpherical:Stitched>true</GSpherical:Stitched>'
       b'<GSpherical:StitchingSoftware>Rewind promo renderer</GSpherical:StitchingSoftware>'
       b'<GSpherical:ProjectionType>equirectangular</GSpherical:ProjectionType>'
       b'</rdf:SphericalVideo>')


def boxes(data, start, end):
    i = start
    while i + 8 <= end:
        size, typ = struct.unpack(">I4s", data[i:i + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", data[i + 8:i + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - i
        yield i, size, typ, hdr
        i += size


def child(data, off, size, hdr, typ):
    for c in boxes(data, off + hdr, off + size):
        if c[2] == typ:
            return c
    return None


def inject(src, dst):
    data = bytearray(open(src, "rb").read())
    top = {b[2]: b for b in boxes(data, 0, len(data))}
    moov, mdat = top[b"moov"], top[b"mdat"]
    if moov[0] < mdat[0]:
        raise SystemExit("moov is before mdat; render without +faststart")
    if moov[3] != 8:
        raise SystemExit("64-bit moov size not handled")
    for trak in [b for b in boxes(data, moov[0] + 8, moov[0] + moov[1]) if b[2] == b"trak"]:
        mdia = child(data, *trak[:2], trak[3], b"mdia")
        hdlr = mdia and child(data, mdia[0], mdia[1], mdia[3], b"hdlr")
        if hdlr and data[hdlr[0] + hdlr[3] + 8: hdlr[0] + hdlr[3] + 12] == b"vide":
            box = struct.pack(">I4s", 8 + 16 + len(XML), b"uuid") + UUID + XML
            end = trak[0] + trak[1]
            data[end:end] = box
            struct.pack_into(">I", data, trak[0], trak[1] + len(box))
            struct.pack_into(">I", data, moov[0], moov[1] + len(box))
            open(dst, "wb").write(data)
            return
    raise SystemExit("no video track found")


if __name__ == "__main__":
    inject(sys.argv[1], sys.argv[2])

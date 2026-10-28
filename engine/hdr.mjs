// 🌈 HDR footage and HDR export - the FFmpeg colour steps the editor (preview copies, thumbnails) and the render share.
// HDR footage = Rec. 2020 with a PQ (HDR10, SMPTE 2084) or HLG (ARIB STD-B67) transfer, read from the file's colour tags.
//   - SDR work (the monitor, every normal export): HDR footage is tone-mapped to Rec. 709 (Hable curve - highlights
//     rolled off instead of clipped), so it looks right instead of grey and flat.
//   - HDR export (Sequence Settings › Working colour space HLG / PQ): the picture is built in HLG - HDR footage goes in as
//     HLG (PQ converted), SDR shots, titles and graphics are lifted into it with SDR white at 203 nits (ITU-R BT.2408) -
//     and the file is HLG, or PQ (HDR10) converted at the very end. So HDR highlights stay HDR.

// 'pq' | 'hlg' | null from an ffprobe video stream
export function hdrOf(v) {
  const t = String(v?.color_transfer || '').toLowerCase();
  return t === 'smpte2084' ? 'pq' : t === 'arib-std-b67' ? 'hlg' : null;
}
const TIN = { pq: 'smpte2084', hlg: 'arib-std-b67' };

// HDR -> SDR Rec. 709 (8-bit 4:2:0), ending in the format named
export const toSdr = (hdr, fmt = 'yuv420p') =>
  `zscale=tin=${TIN[hdr]}:pin=bt2020:min=bt2020nc:rin=tv:t=linear:p=bt2020:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=${fmt}`;
// PQ footage -> HLG (for the HDR working space); HLG footage stays as it is
export const pqToHlg = (fmt = 'yuv420p') => `zscale=tin=smpte2084:pin=bt2020:min=bt2020nc:rin=tv:t=arib-std-b67:p=bt2020:m=bt2020nc:r=tv:npl=1000,format=${fmt}`;
// SDR Rec. 709 -> HLG, SDR white at 203 nits
export const sdrToHlg = () => 'format=yuv420p,zscale=tin=bt709:pin=bt709:min=bt709:rin=tv:t=arib-std-b67:p=bt2020:m=bt2020nc:r=tv:npl=203,format=yuv420p';
// the same for a picture with transparency (titles, graphics, logos - often RGBA), as filter-graph lines from label i
// to label o: its alpha is taken off and put back, because zscale moves / halves an alpha plane it converts
export const sdrToHlgAlpha = (i, o) => [`[${i}]format=yuva420p,split[${o}x][${o}y]`, `[${o}x]alphaextract[${o}a]`, `[${o}y]${sdrToHlg()}[${o}c]`, `[${o}c][${o}a]alphamerge[${o}]`];
// the finished HLG picture -> the file: HLG 10-bit as it is, or PQ (HDR10) 10-bit
export const hlgOut = (target) => (target === 'pq' ? 'zscale=tin=arib-std-b67:pin=bt2020:min=bt2020nc:rin=tv:t=smpte2084:p=bt2020:m=bt2020nc:r=tv:npl=1000,format=yuv420p10le' : 'format=yuv420p10le');

// the filters a source's picture gets as it comes in (a prefix ending in ',' or ''): out = null (SDR work) or 'hlg' / 'pq'
export function sourceIn(hdr, out) {
  if (!hdr) return '';
  if (!out) return `${toSdr(hdr)},`;
  return hdr === 'pq' ? `${pqToHlg()},` : '';
}

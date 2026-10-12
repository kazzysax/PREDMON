// Turn any chosen photo into a small square JPEG (data URL), cropped from the middle.
export async function squarePhoto(file: File, size = 320): Promise<string> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp|heic)$/i.test(file.name)) throw new Error('Choose a JPEG, PNG or WebP photo.');
  if (file.size > 15_000_000) throw new Error('That photo is too big. Choose one under 15 MB.');
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('We couldn\'t read that photo. Try a JPEG or PNG.'); });
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  for (const q of [0.85, 0.7, 0.55]) { const url = c.toDataURL('image/jpeg', q); if (url.length < 110_000) return url; }
  throw new Error('That photo is too detailed. Try another.');
}

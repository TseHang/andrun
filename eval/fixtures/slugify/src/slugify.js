export function slugify(title) {
  return title.toLowerCase().trim().replace(/[^a-z0-9]/g, "-");
}

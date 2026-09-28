import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const BUCKET = 'excuses';
const CHUNK = 100;

export type Removed = { absences: number; files: number; bytes: number };

/**
 * Deletes absences together with their excuse files (comments, history and attachment rows go with
 * them by cascade). Files are removed first: if Storage fails, the rows stay and the next run retries.
 */
export async function deleteAbsences(db: SupabaseClient, ids: number[]): Promise<Removed> {
  const removed: Removed = { absences: 0, files: 0, bytes: 0 };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data: files, error } = await db.from('attachments').select('path, size').in('absence_id', chunk);
    if (error) throw new Error(error.message);
    const paths = (files || []).map((f) => f.path as string);
    for (let j = 0; j < paths.length; j += CHUNK) {
      const { error: storageError } = await db.storage.from(BUCKET).remove(paths.slice(j, j + CHUNK));
      if (storageError) throw new Error(storageError.message);
    }
    const { error: deleteError, count } = await db.from('absences').delete({ count: 'exact' }).in('id', chunk);
    if (deleteError) throw new Error(deleteError.message);
    removed.absences += count ?? chunk.length;
    removed.files += paths.length;
    removed.bytes += (files || []).reduce((n, f) => n + (Number(f.size) || 0), 0);
  }
  return removed;
}

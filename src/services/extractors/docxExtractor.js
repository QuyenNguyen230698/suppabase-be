import mammoth from 'mammoth';

export async function extract(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  if (result.messages?.length) {
    result.messages.forEach((m) => {
      if (m.type === 'warning') console.warn('[docxExtractor]', m.message);
    });
  }
  return result.value;
}

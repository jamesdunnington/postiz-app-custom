import { PinterestProvider } from './pinterest.provider';

describe('PinterestProvider.boards', () => {
  const jsonResponse = (body: any) => ({
    ok: true,
    json: async () => body,
  });

  it('does not request archived boards when includeArchived is not passed', async () => {
    const provider = new PinterestProvider();
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ items: [] }) as any);

    await provider.boards('token');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.pinterest.com/v5/boards?page_size=250&privacy=ALL',
      expect.anything()
    );
    fetchSpy.mockRestore();
  });

  it('requests archived boards when includeArchived is true', async () => {
    const provider = new PinterestProvider();
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ items: [] }) as any);

    await provider.boards('token', { includeArchived: true });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.pinterest.com/v5/boards?page_size=250&include_archived=true&privacy=ALL',
      expect.anything()
    );
    fetchSpy.mockRestore();
  });
});

import { PinterestProvider } from './pinterest.provider';

describe('PinterestProvider.deleteBoard', () => {
  it('reports success on a 204 response', async () => {
    const provider = new PinterestProvider();
    jest
      .spyOn(provider as any, 'fetch')
      .mockResolvedValue({ status: 204 } as any);

    const result = await provider.deleteBoard('internal-id', 'token', 'board-1');

    expect(result).toEqual({ success: true });
    expect((provider as any).fetch).toHaveBeenCalledWith(
      'https://api.pinterest.com/v5/boards/board-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      })
    );
  });

  it('reports failure on a non-2xx response', async () => {
    const provider = new PinterestProvider();
    jest
      .spyOn(provider as any, 'fetch')
      .mockResolvedValue({ status: 404 } as any);

    const result = await provider.deleteBoard('internal-id', 'token', 'board-1');

    expect(result).toEqual({ success: false });
  });
});

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
      'https://api.pinterest.com/v5/boards?page_size=250',
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
      'https://api.pinterest.com/v5/boards?page_size=250&include_archived=true',
      expect.anything()
    );
    fetchSpy.mockRestore();
  });
});

import { PinterestProvider } from './pinterest.provider';

describe('PinterestProvider.movePin', () => {
  it('reports success on a 200 response and PATCHes the target board_id', async () => {
    const provider = new PinterestProvider();
    jest
      .spyOn(provider as any, 'fetch')
      .mockResolvedValue({ status: 200 } as any);

    const result = await provider.movePin(
      'internal-id',
      'token',
      'pin-1',
      'board-2'
    );

    expect(result).toEqual({ success: true });
    expect((provider as any).fetch).toHaveBeenCalledWith(
      'https://api.pinterest.com/v5/pins/pin-1',
      expect.objectContaining({
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ board_id: 'board-2' }),
      })
    );
  });

  it('reports failure on a non-200 response', async () => {
    const provider = new PinterestProvider();
    jest
      .spyOn(provider as any, 'fetch')
      .mockResolvedValue({ status: 404 } as any);

    const result = await provider.movePin(
      'internal-id',
      'token',
      'pin-1',
      'board-2'
    );

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

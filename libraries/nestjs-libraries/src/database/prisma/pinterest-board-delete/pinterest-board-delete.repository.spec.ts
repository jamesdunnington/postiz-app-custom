import { excludeAlreadyPendingBoards } from './pinterest-board-delete.repository';

describe('excludeAlreadyPendingBoards', () => {
  it('keeps boards not already pending', () => {
    const result = excludeAlreadyPendingBoards(
      [
        { boardId: 'b1', boardName: 'Board 1' },
        { boardId: 'b2', boardName: 'Board 2' },
      ],
      ['b3']
    );
    expect(result).toEqual([
      { boardId: 'b1', boardName: 'Board 1' },
      { boardId: 'b2', boardName: 'Board 2' },
    ]);
  });

  it('drops boards already pending', () => {
    const result = excludeAlreadyPendingBoards(
      [
        { boardId: 'b1', boardName: 'Board 1' },
        { boardId: 'b2', boardName: 'Board 2' },
      ],
      ['b1']
    );
    expect(result).toEqual([{ boardId: 'b2', boardName: 'Board 2' }]);
  });

  it('returns an empty array when everything is already pending', () => {
    const result = excludeAlreadyPendingBoards(
      [{ boardId: 'b1', boardName: 'Board 1' }],
      ['b1']
    );
    expect(result).toEqual([]);
  });
});

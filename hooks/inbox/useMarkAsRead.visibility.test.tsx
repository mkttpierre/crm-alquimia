import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMarkAsRead } from './useMarkAsRead';
const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/hooks/auth/AuthProvider', () => ({ useAuth: () => ({ user: {} }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }), useMutation: () => ({ mutate: post }) }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
it('não marca aba oculta e marca ao voltar com a conversa selecionada', () => {
  vi.useFakeTimers();
  let visibilidade = 'hidden';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilidade as DocumentVisibilityState);
  renderHook(() => useMarkAsRead('conversa', 1));
  act(() => vi.advanceTimersByTime(2000));
  expect(post).not.toHaveBeenCalled();
  visibilidade = 'visible';
  act(() => { document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(2000); });
  expect(post).toHaveBeenCalledWith('conversa');
  vi.restoreAllMocks();
});

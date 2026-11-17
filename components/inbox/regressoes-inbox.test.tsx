import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/lib/types/messaging';
import { MessageBubble } from './MessageBubble';
import { ConversationList } from './ConversationList';

vi.mock('@/hooks/channels/useChannelSessions', () => ({ useChannelSessions: () => ({ data: [] }) }));
vi.mock('@/hooks/ai/useAutomaticoAtivo', () => ({ useAutomaticoAtivo: () => ({ data: false }) }));
afterEach(cleanup);
describe('inbox com registros legados e paginação', () => {
  it('mostra system outbound como nota interna sem confirmação de envio', () => {
    const message = { id: 'm', type: 'system', direction: 'outbound', status: 'sent', sent_at: '2026-01-01T12:00:00Z', body: 'Nota antiga', metadata: null } as unknown as Message;
    const { container } = render(<MessageBubble message={message} />);
    expect(screen.getByText('Nota antiga')).toBeTruthy();
    expect(screen.getByText('Nota interna')).toBeTruthy();
    expect(screen.queryByLabelText('Enviada')).toBeNull();
    expect(container.querySelector('.bg-primary')).toBeNull();
  });
  it('permite carregar página seguinte quando filtro esconde a página atual', () => {
    const fetchNextPage = vi.fn();
    const q = { data: { pages: [{ data: [{ id: 'lida', unread_count_for_assignee: 0 }] }] }, hasNextPage: true, fetchNextPage, isLoading: false, isError: false, isFetchingNextPage: false };
    render(<ConversationList listQuery={q as never} filters={{}} selectedId={null} onSelect={() => {}} clientFilter={(c) => (c.unread_count_for_assignee ?? 0) > 0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
  });
});

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { JornadaDoNegocio } from './JornadaDoNegocio';

describe('jornada do negócio', () => {
  it('identifica a etapa atual sem declarar as posteriores concluídas', () => {
    render(<JornadaDoNegocio stages={[{ id: 'a', name: 'Novo' }, { id: 'b', name: 'Contato' }, { id: 'c', name: 'Ganho' }]} stageId="b" />);
    expect(screen.getByText('Contato').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Ganho').closest('li')).not.toHaveAttribute('aria-current');
  });
});

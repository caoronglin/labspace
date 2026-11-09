import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Me } from '../services/api';

interface AuthCtx {
  me: Me | undefined;
  isAdmin: boolean;
  isTeacher: boolean;
  loading: boolean;
  refetch: () => void;
}

const Ctx = createContext<AuthCtx>({
  me: undefined,
  isAdmin: false,
  isTeacher: false,
  loading: true,
  refetch: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    staleTime: 60_000,
  });

  const value: AuthCtx = {
    me: data,
    isAdmin: !!data?.isAdmin,
    isTeacher: !!data?.isTeacher,
    loading: isLoading,
    refetch: () => void refetch(),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

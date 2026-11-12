// shadcn/ui table (MIT), new-york density adapted to Mona Sans.
import * as React from 'react';
import { cn } from '../../lib/utils.ts';
export function Table({ className, ...props }: React.ComponentProps<'table'>) { return <div className="table-wrap"><table className={cn('w-full caption-bottom text-sm', className)} {...props}/></div>; }
export function TableHead({ className, ...props }: React.ComponentProps<'th'>) { return <th className={cn('text-left text-muted-foreground font-semibold', className)} {...props}/>; }
export function TableRow({ className, onClick, ...props }: React.ComponentProps<'tr'>) { return <tr className={cn('border-b transition-colors', className)} data-clickable={onClick ? '' : undefined} onClick={onClick} {...props}/>; }

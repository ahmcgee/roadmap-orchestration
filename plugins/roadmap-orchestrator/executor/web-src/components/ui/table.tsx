// shadcn/ui table (MIT), new-york density adapted to Mona Sans; the look lives in styles.css.
import * as React from 'react';
import { cn } from '../../lib/utils.ts';
export function Table({ className, ...props }: React.ComponentProps<'table'>) { return <div className="table-wrap"><table className={cn('w-full caption-bottom', className)} {...props}/></div>; }
export function TableHead({ className, ...props }: React.ComponentProps<'th'>) { return <th className={cn('text-left', className)} {...props}/>; }
export function TableRow({ className, onClick, ...props }: React.ComponentProps<'tr'>) { return <tr className={className} data-clickable={onClick ? '' : undefined} onClick={onClick} {...props}/>; }

// shadcn/ui table (MIT), new-york density adapted to Barlow.
import * as React from 'react';
import { cn } from '../../lib/utils.ts';
export function Table({ className, ...props }: React.ComponentProps<'table'>) { return <div className="table-wrap"><table className={cn('w-full caption-bottom text-sm', className)} {...props}/></div>; }
export function TableHead(props: React.ComponentProps<'th'>) { return <th className="text-left text-muted-foreground font-medium" {...props}/>; }
export function TableRow(props: React.ComponentProps<'tr'>) { return <tr className="border-b transition-colors hover:bg-accent" {...props}/>; }

// shadcn/ui command (MIT), new-york command menu.
import * as React from 'react';
import { Command as Primitive } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '../../lib/utils.ts';
export function Command({ className, ...props }: React.ComponentProps<typeof Primitive>) { return <Primitive className={cn('command flex w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground', className)} {...props} />; }
export function CommandInput(props: React.ComponentProps<typeof Primitive.Input>) { return <div className="command-search flex items-center gap-2 border-b px-2"><Search size={14}/><Primitive.Input className="h-9 w-full bg-transparent text-sm outline-none" {...props}/></div>; }
export const CommandList = Primitive.List;
export const CommandEmpty = Primitive.Empty;
export function CommandItem({ className, ...props }: React.ComponentProps<typeof Primitive.Item>) { return <Primitive.Item className={cn('command-item relative flex cursor-default select-none items-center rounded-sm px-2 py-2 text-sm outline-none', className)} {...props}/>; }

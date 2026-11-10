// shadcn/ui popover (MIT), new-york floating layer.
import * as React from 'react';
import { Popover as Primitive } from 'radix-ui';
import { cn } from '../../lib/utils.ts';
export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export function PopoverContent({ className, align = 'start', sideOffset = 4, ...props }: React.ComponentProps<typeof Primitive.Content>) { return <Primitive.Portal><Primitive.Content align={align} sideOffset={sideOffset} className={cn('ui-popover z-50 w-80 rounded-lg border bg-popover p-2 text-popover-foreground shadow-md outline-none', className)} {...props} /></Primitive.Portal>; }
